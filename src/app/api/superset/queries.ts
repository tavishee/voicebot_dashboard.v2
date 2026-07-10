export function combinedQuery(date: string, nextDate: string, leadIds: string[]) {
  if (!leadIds.length) {
    return `SELECT 0 AS cc_sent, 0 AS cc_attempted, 0 AS cc_connected, 0 AS cc_converted`;
  }

  const idChunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 1000) idChunks.push(leadIds.slice(i, i + 1000));
  const qualifiedLeadSources = idChunks.map(chunk => {
    const values = chunk.map(id => `('${id.replace(/'/g, "''")}')`).join(', ');
    return `SELECT CAST(id AS VARCHAR) AS lead_id FROM (VALUES ${values}) AS t(id)`;
  }).join('\n    UNION ALL\n    ');

  return `
WITH qualified_leads AS (
    ${qualifiedLeadSources}
),
proposal_dedup AS (
    SELECT proposal_id, vehicle_type, created_by, owned_by, coverage_type
    FROM (
        SELECT id, proposal_id, vehicle_type, created_by, owned_by, coverage_type,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.proposal
        WHERE modified_on >= DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY)
          AND modified_on < CAST('${nextDate}' AS DATE)
          AND date >= DATE_FORMAT(DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY), '%Y%m%d')
          AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
          AND CAST(COALESCE(created_by, owned_by) AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)
    ) p
    WHERE rn = 1
),
order_detail_dedup AS (
    SELECT oms_order_id, proposal_id
    FROM (
        SELECT id, oms_order_id, proposal_id,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.order_detail
        WHERE modified_on >= DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY)
          AND modified_on < CAST('${nextDate}' AS DATE)
          AND date >= DATE_FORMAT(DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY), '%Y%m%d')
          AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
          AND proposal_id IN (SELECT proposal_id FROM proposal_dedup)
    ) od
    WHERE rn = 1
),
order_item_dedup AS (
    SELECT oms_order_id, oms_item_id, price, status, created_on
    FROM (
        SELECT id, oms_order_id, oms_item_id, price, status, created_on,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.order_item
        WHERE modified_on >= DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY)
          AND modified_on < CAST('${nextDate}' AS DATE)
          AND date >= DATE_FORMAT(DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY), '%Y%m%d')
          AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
          AND created_on >= '${date} 00:00:00'
          AND created_on < '${nextDate} 00:00:00'
          AND oms_order_id IN (SELECT oms_order_id FROM order_detail_dedup)
    ) oi
    WHERE rn = 1
),
policy_purchases AS (
    SELECT p.vehicle_type AS product,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR) AS customer_id,
        DATE(MIN(oi.created_on)) AS purchase_date,
        p.proposal_id, oi.oms_item_id,
        MAX(CASE WHEN oi.status IN ('issued', 'policy_pdf_generated') THEN 1 ELSE 0 END) AS issued_flag
    FROM order_item_dedup oi
    JOIN order_detail_dedup od ON oi.oms_order_id = od.oms_order_id
    JOIN proposal_dedup p ON p.proposal_id = od.proposal_id
    WHERE p.coverage_type IN ('comprehensive_1y_1y', 'own_damage_1y', 'third_party_1y')
      AND oi.created_on >= DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 60 DAY)
      AND oi.created_on < CAST('${nextDate}' AS DATE)
    GROUP BY p.vehicle_type, oi.oms_item_id,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR), p.proposal_id
    HAVING DATE(MIN(oi.created_on)) >= '${date}'
       AND DATE(MIN(oi.created_on)) < '${nextDate}'
),
purchase_call_history AS (
    SELECT CAST(c.customer_id AS VARCHAR) AS customer_id,
        c.agent, DATE(c.created_on) AS call_date,
        SUM(
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 1), '') AS INT), 0) * 3600 +
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 2), '') AS INT), 0) * 60 +
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 3), '') AS INT), 0)
        ) AS daily_talk_seconds
    FROM glue_catalog.recent_search_partition.enser_callback_data c
    WHERE c.service IN ('Fresh_Car', 'Renewal_Car', 'four_wheeler')
      AND c.customer_id NOT LIKE 'NA'
      AND c.call_type IN ('Outbound', 'CallBack', 'Manual')
      AND (c.source IS NULL OR c.source IN ('enser', 'reliable'))
      AND c.date >= DATE_FORMAT(DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 110 DAY), '%Y%m%d')
      AND c.date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
      AND c.created_on >= DATE_SUB(CAST('${nextDate}' AS DATE), INTERVAL 110 DAY)
      AND c.created_on < CAST('${nextDate}' AS DATE)
      AND LOWER(c.agent) NOT IN ('no agent')
      AND CAST(c.customer_id AS VARCHAR) IN (SELECT DISTINCT customer_id FROM policy_purchases)
    GROUP BY CAST(c.customer_id AS VARCHAR), c.agent, DATE(c.created_on)
),
purchase_attribution AS (
    SELECT h.customer_id, h.agent, h.call_date,
        p.proposal_id, p.oms_item_id, p.purchase_date, p.issued_flag,
        SUM(CASE WHEN h.call_date <= p.purchase_date THEN h.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY h.customer_id, p.proposal_id) AS customer_talk_seconds,
        SUM(CASE WHEN h.call_date <= p.purchase_date THEN h.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY h.customer_id, h.agent, p.proposal_id) AS agent_talk_seconds
    FROM purchase_call_history h
    JOIN policy_purchases p ON h.customer_id = p.customer_id
),
ranked_attribution AS (
    SELECT a.*,
        ROW_NUMBER() OVER (
          PARTITION BY a.customer_id, a.proposal_id, a.oms_item_id
          ORDER BY CASE WHEN a.call_date <= a.purchase_date
            AND DATEDIFF(a.purchase_date, a.call_date) BETWEEN 0 AND 45
            THEN a.agent_talk_seconds ELSE NULL END DESC
        ) AS agent_rank
    FROM purchase_attribution a
    WHERE a.customer_talk_seconds >= 30
      AND a.call_date <= a.purchase_date
      AND DATEDIFF(a.purchase_date, a.call_date) BETWEEN 0 AND 45
),
conversions AS (
    SELECT DISTINCT customer_id
    FROM ranked_attribution
    WHERE agent_rank = 1
      AND issued_flag = 1
),
raw_calls AS (
    SELECT CAST(customer_id AS VARCHAR) AS customer_id,
        service, disposition1, disposition2, disposition3, talk_duration
    FROM glue_catalog.recent_search_partition.enser_callback_data
    WHERE (source = 'enser' OR source IS NULL)
      AND customer_id <> 'NA'
      AND date >= DATE_FORMAT(CAST('${date}' AS DATE), '%Y%m%d')
      AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
      AND created_on >= '${date} 00:00:00'
      AND created_on < '${nextDate} 00:00:00'
      AND CAST(customer_id AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)
)
SELECT
    COUNT(DISTINCT r.customer_id) AS cc_sent,
    COUNT(DISTINCT CASE WHEN COALESCE(disposition1,'') <> ''
      OR COALESCE(disposition2,'') <> '' OR COALESCE(disposition3,'') <> ''
      THEN r.customer_id END) AS cc_attempted,
    COUNT(DISTINCT CASE WHEN
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration,':',1),'') AS INT),0)*3600 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration,':',2),'') AS INT),0)*60 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration,':',3),'') AS INT),0) > 0
      THEN r.customer_id END) AS cc_connected,
    COUNT(DISTINCT CASE WHEN cv.customer_id IS NOT NULL AND r.service = 'Fresh_Car'
      THEN r.customer_id END) AS cc_converted,
    ROUND(COUNT(*) / NULLIF(COUNT(DISTINCT r.customer_id), 0), 1) AS cc_churn
FROM raw_calls r
LEFT JOIN conversions cv ON r.customer_id = cv.customer_id`;
}

export function receivedQuery(date: string, leadIds: string[]) {
  if (!leadIds.length) return `SELECT 0 AS cc_sent, 0 AS cc_attempted, 0 AS cc_connected`;

  const idChunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 1000) idChunks.push(leadIds.slice(i, i + 1000));
  const qualifiedLeadSources = idChunks.map(chunk => {
    const values = chunk.map((id: string) => `('${id.replace(/'/g, "''")}')`).join(', ');
    return `SELECT CAST(id AS VARCHAR) AS lead_id FROM (VALUES ${values}) AS t(id)`;
  }).join('\n    UNION ALL\n    ');

  // Use same table and filters as MIS team
  // service = 'Fresh_Car' for fresh leads, 'Renewal_Car' for retained
  // dl_last_updated date filter matches the report date
  return `
WITH qualified_leads AS (
    ${qualifiedLeadSources}
),
enser_calls AS (
  SELECT
    CAST(customer_id AS VARCHAR) AS customer_id,
    disposition1, disposition2, disposition3,
    talk_duration, start_time
  FROM hive.recent_search.enser_callback_data_snapshot_v3
  WHERE service IN ('Fresh_Car', 'Renewal_Car')
    AND dl_last_updated >= date('${date}')
    AND dl_last_updated < date('${date}') + interval '1' day
    AND CAST(customer_id AS VARCHAR) IN (SELECT lead_id FROM qualified_leads)
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
FROM enser_calls`;
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
