export function cdrQuery(date: string, nextDate: string) {
  return `
WITH cdr AS (
  SELECT service, start_time, customer_id, call_number, disposition1,
    disposition2, disposition3, talk_duration, agent
  FROM hive.recent_search.enser_callback_data_snapshot_v3
  WHERE (source = 'enser' OR source IS NULL)
    AND customer_id <> 'NA'
    AND created_on >= TIMESTAMP '${date} 00:00:00'
    AND created_on < TIMESTAMP '${nextDate} 00:00:00'
    AND dl_last_updated >= DATE '${date}'
    AND dl_last_updated < DATE '${nextDate}'
    AND service = 'Fresh_Car'
)
SELECT
  COUNT(DISTINCT customer_id) AS cc_sent,
  COUNT(DISTINCT CASE WHEN COALESCE(disposition1, '') <> ''
    OR COALESCE(disposition2, '') <> '' OR COALESCE(disposition3, '') <> ''
    THEN customer_id END) AS cc_attempted,
  COUNT(DISTINCT CASE WHEN UPPER(COALESCE(disposition1, '')) LIKE '%CONNECT%'
    OR UPPER(COALESCE(disposition2, '')) LIKE '%CONNECT%'
    OR UPPER(COALESCE(disposition3, '')) LIKE '%CONNECT%'
    THEN customer_id END) AS cc_connected
FROM cdr`;
}

export function conversionQuery(date: string, nextDate: string) { return `
WITH proposal_dedup AS (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM hive.motor_proposal.proposal_snapshot_v3
        WHERE modified_on >= CURRENT_DATE - INTERVAL '60' DAY
          AND dl_last_updated >= CURRENT_DATE - INTERVAL '60' DAY
    ) t WHERE rn = 1
),
order_detail_dedup AS (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM hive.motor_proposal.order_detail_snapshot_v3
        WHERE modified_on >= CURRENT_DATE - INTERVAL '60' DAY
          AND dl_last_updated >= CURRENT_DATE - INTERVAL '60' DAY
    ) t WHERE rn = 1
),
order_item_dedup AS (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM hive.motor_proposal.order_item_snapshot_v3
        WHERE modified_on >= CURRENT_DATE - INTERVAL '60' DAY
          AND dl_last_updated >= CURRENT_DATE - INTERVAL '60' DAY
    ) t WHERE rn = 1
),
policy_purchases AS (
    SELECT p.vehicle_type AS product,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR) AS customer_id,
        DATE(MIN(oi.created_on)) AS purchase_date, MIN(oi.created_on) AS purchase_ts,
        p.proposal_id, oi.oms_item_id, MAX(oi.price) AS premium,
        MAX(CASE WHEN oi.status IN ('issued', 'policy_pdf_generated') THEN 1 ELSE 0 END) AS issued_flag
    FROM order_item_dedup oi
    JOIN order_detail_dedup od ON oi.oms_order_id = od.oms_order_id
    JOIN proposal_dedup p ON p.proposal_id = od.proposal_id
    WHERE p.coverage_type IN ('comprehensive_1y_1y', 'own_damage_1y', 'third_party_1y')
      AND oi.created_on >= CURRENT_DATE - INTERVAL '60' DAY
    GROUP BY p.vehicle_type, oi.oms_item_id,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR), p.proposal_id
),
cc_data AS (
    SELECT * FROM hive.recent_search.enser_callback_data_snapshot_v3 c
    WHERE service IN ('Fresh_Car', 'Renewal_Car', 'four_wheeler')
      AND customer_id NOT LIKE 'NA'
      AND call_type IN ('Outbound', 'CallBack', 'Manual')
      AND (source IS NULL OR source IN ('enser', 'reliable'))
      AND created_on >= CURRENT_DATE - INTERVAL '110' DAY
      AND dl_last_updated >= CURRENT_DATE - INTERVAL '110' DAY
      AND LOWER(agent) NOT IN ('no agent')
),
daily_calls AS (
    SELECT CAST(c.customer_id AS VARCHAR) AS customer_id, c.agent,
        DATE(c.created_on) AS call_date,
        SUM(COALESCE(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 1), '') AS INTEGER), 0) * 3600 +
            COALESCE(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 2), '') AS INTEGER), 0) * 60 +
            COALESCE(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 3), '') AS INTEGER), 0)) AS daily_talk_seconds,
        COUNT(*) AS call_count, MIN(c.created_on) AS first_call_timestamp,
        MIN(HOUR(c.created_on)) AS first_hour, MIN(c.start_time) AS start_time,
        MIN(c.end_time) AS end_time
    FROM cc_data c
    GROUP BY CAST(c.customer_id AS VARCHAR), c.agent, DATE(c.created_on)
),
cumulative_calls AS (
    SELECT cc.*, p.product, p.proposal_id, p.oms_item_id, p.premium,
        p.purchase_date, p.purchase_ts, p.issued_flag,
        SUM(CASE WHEN p.purchase_date IS NOT NULL AND cc.call_date <= p.purchase_date
            THEN cc.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY cc.customer_id, p.proposal_id) AS cumulative_talk_seconds,
        SUM(CASE WHEN p.purchase_date IS NOT NULL AND cc.call_date <= p.purchase_date
            THEN cc.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY cc.customer_id, cc.agent, p.proposal_id) AS cumulative_talk_seconds_agent
    FROM daily_calls cc LEFT JOIN policy_purchases p ON cc.customer_id = p.customer_id
),
attribution_ranking AS (
    SELECT cc.*,
        CASE WHEN cc.cumulative_talk_seconds >= 30 AND cc.purchase_date IS NOT NULL
          AND cc.call_date <= cc.purchase_date
          AND DATE_DIFF('day', cc.call_date, cc.purchase_date) BETWEEN 0 AND 45 THEN 1 ELSE 0 END AS attribution_eligible,
        ROW_NUMBER() OVER (PARTITION BY cc.customer_id, cc.proposal_id, cc.oms_item_id
          ORDER BY CASE WHEN cc.call_date <= cc.purchase_date
            AND DATE_DIFF('day', cc.call_date, cc.purchase_date) BETWEEN 0 AND 45
            THEN cc.cumulative_talk_seconds_agent ELSE NULL END DESC) AS agent_rank
    FROM cumulative_calls cc
)
SELECT COUNT(DISTINCT customer_id) AS cc_converted FROM (
    SELECT ar.first_call_timestamp AS created_on_timestamp, ar.call_date AS created_dt,
      ar.Agent, ar.customer_id, ar.purchase_date, ar.purchase_ts, ar.product,
      ar.proposal_id, ar.issued_flag, ar.oms_item_id, ar.premium, ar.start_time,
      ar.end_time, ar.daily_talk_seconds AS talk_duration_seconds,
      ar.cumulative_talk_seconds, ar.cumulative_talk_seconds_agent, ar.agent_rank,
      ar.attribution_eligible,
      CASE WHEN ar.daily_talk_seconds > 0 THEN 1 ELSE 0 END AS is_connected,
      CASE WHEN ar.daily_talk_seconds > 0 THEN 1 ELSE 0 END AS is_valid_conversation,
      CASE WHEN ar.attribution_eligible = 1 AND ar.agent_rank = 1 THEN ar.customer_id ELSE NULL END AS is_attribution,
      1 AS call_sequence, ar.daily_talk_seconds AS winning_agent_talk_seconds
    FROM attribution_ranking ar
) a
WHERE purchase_date >= DATE '${date}'
  AND purchase_date < DATE '${nextDate}'
  AND is_attribution IS NOT NULL`;
}
