export function combinedQuery(date: string, nextDate: string, leadIds: string[]) {
  if (!leadIds.length) {
    return `SELECT 0 AS cc_sent, 0 AS cc_attempted, 0 AS cc_connected, 0 AS cc_converted`;
  }

  const idChunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 1000) idChunks.push(leadIds.slice(i, i + 1000));
  const qualifiedLeadSources = idChunks.map(chunk => {
    const values = chunk.map((id: string) => `('${id.replace(/'/g, "''")}')`).join(', ');
    return `SELECT CAST(id AS VARCHAR) AS lead_id FROM (VALUES ${values}) AS t(id)`;
  }).join('\n    UNION ALL\n    ');

  return `
WITH qualified_leads AS (
    ${qualifiedLeadSources}
),
cdr AS (
  SELECT
    CAST(customer_id AS VARCHAR) AS customer_id,
    disposition1, disposition2, disposition3, talk_duration
  FROM hive.recent_search.enser_callback_data_snapshot_v3
  WHERE (source = 'enser' OR source IS NULL)
    AND customer_id NOT LIKE 'NA'
    AND service IN ('Fresh_Car', 'Renewal_Car')
    AND dl_last_updated >= date('${date}')
    AND dl_last_updated < date('${date}') + interval '2' day
    AND date(start_time) = date('${date}')
    AND CAST(customer_id AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)
),
conversions AS (
  SELECT CAST(a.customer_id AS VARCHAR) AS customer_id
  FROM marketplace.sales_order_snapshot_v3 a
  LEFT JOIN marketplace.sales_order_item_snapshot_v3 b ON a.id = b.order_id
  WHERE b.vertical_id = 173
    AND b.name NOT IN (
      'Health Insurance','Health Advantage Plus','HDFC Life Term Insurance',
      'Term Life Insurance','Compulsory Personal Accident 4W',
      'Compulsory Personal Accident 2W','Two Wheeler Insurance',
      'Compulsory Personal Accident 2W - Standalone'
    )
    AND a.dl_last_updated >= date('${date}')
    AND a.dl_last_updated < date('${date}') + interval '50' day
    AND b.dl_last_updated >= date('${date}')
    AND b.dl_last_updated < date('${date}') + interval '50' day
    AND date(a.created_at) >= date('${date}')
    AND date(a.created_at) < date('${nextDate}')
    AND CAST(a.customer_id AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)
)
SELECT
  COUNT(DISTINCT c.customer_id) AS cc_sent,
  COUNT(DISTINCT CASE WHEN COALESCE(c.disposition1,'') <> ''
    OR COALESCE(c.disposition2,'') <> '' OR COALESCE(c.disposition3,'') <> ''
    THEN c.customer_id END) AS cc_attempted,
  COUNT(DISTINCT CASE WHEN
    COALESCE(TRY_CAST(SPLIT_PART(c.talk_duration,':',1) AS INT),0)*3600 +
    COALESCE(TRY_CAST(SPLIT_PART(c.talk_duration,':',2) AS INT),0)*60 +
    COALESCE(TRY_CAST(SPLIT_PART(c.talk_duration,':',3) AS INT),0) > 0
    THEN c.customer_id END) AS cc_connected,
  COUNT(DISTINCT cv.customer_id) AS cc_converted
FROM cdr c
LEFT JOIN conversions cv ON c.customer_id = cv.customer_id`;
}


export function receivedQuery(date: string, leadIds: string[]) {
  if (!leadIds.length) return `SELECT 0 AS cc_sent, 0 AS cc_attempted, 0 AS cc_connected`;

  const idChunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 1000) idChunks.push(leadIds.slice(i, i + 1000));
  const qualifiedLeadSources = idChunks.map(chunk => {
    const values = chunk.map((id: string) => `('${id.replace(/'/g, "''")}')`).join(', ');
    return `SELECT CAST(id AS VARCHAR) AS lead_id FROM (VALUES ${values}) AS t(id)`;
  }).join('\n    UNION ALL\n    ');

  return `
WITH qualified_leads AS (
    ${qualifiedLeadSources}
)
SELECT
  COUNT(DISTINCT customer_id) AS cc_sent,
  COUNT(DISTINCT CASE WHEN COALESCE(disposition1,'') <> ''
    OR COALESCE(disposition2,'') <> '' OR COALESCE(disposition3,'') <> ''
    THEN customer_id END) AS cc_attempted,
  COUNT(DISTINCT CASE WHEN
    COALESCE(TRY_CAST(SPLIT_PART(talk_duration,':',1) AS INT),0)*3600 +
    COALESCE(TRY_CAST(SPLIT_PART(talk_duration,':',2) AS INT),0)*60 +
    COALESCE(TRY_CAST(SPLIT_PART(talk_duration,':',3) AS INT),0) > 0
    THEN customer_id END) AS cc_connected
FROM hive.recent_search.enser_callback_data_snapshot_v3
WHERE (source = 'enser' OR source IS NULL)
  AND customer_id NOT LIKE 'NA'
  AND service IN ('Fresh_Car', 'Renewal_Car')
  AND dl_last_updated >= date('${date}')
  AND dl_last_updated < date('${date}') + interval '2' day
  AND date(start_time) = date('${date}')
  AND CAST(customer_id AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)`;
}


export function ccMetricsQueries(date: string, nextDate: string, leadIds: string[]): string[] {
  const base = `
SELECT
    COUNT(*) AS cc_sent,
    SUM(CASE WHEN COALESCE(disposition1, '') <> ''
      OR COALESCE(disposition2, '') <> '' OR COALESCE(disposition3, '') <> ''
      THEN 1 ELSE 0 END) AS cc_attempted,
    SUM(CASE WHEN
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 1), '') AS INT), 0) * 3600 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 2), '') AS INT), 0) * 60 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 3), '') AS INT), 0) > 0
      THEN 1 ELSE 0 END) AS cc_connected
FROM glue_catalog.recent_search_partition.enser_callback_data
WHERE (source = 'enser' OR source IS NULL)
  AND customer_id <> 'NA'
  AND date >= DATE_FORMAT(CAST('${date}' AS DATE), '%Y%m%d')
  AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
  AND created_on >= '${date} 00:00:00'
  AND created_on < '${nextDate} 00:00:00'`;

  if (!leadIds.length) return [base];

  // 200 IDs per chunk — small enough for StarRocks to plan quickly
  const queries: string[] = [];
  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200);
    const inList = chunk.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    queries.push(`${base}
  AND CAST(customer_id AS VARCHAR) IN (${inList})`);
  }
  return queries;
}

// Legacy single-query version for backward compat
export function ccMetricsQuery(date: string, nextDate: string, leadIds: string[] = []) {
  return ccMetricsQueries(date, nextDate, leadIds)[0];
}
