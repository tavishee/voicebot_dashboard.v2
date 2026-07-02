export function combinedQuery(date: string, nextDate: string) { return `
WITH proposal_dedup AS (
    SELECT proposal_id, vehicle_type, created_by, owned_by, coverage_type
    FROM (
        SELECT id, proposal_id, vehicle_type, created_by, owned_by, coverage_type,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.proposal
        WHERE modified_on >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
          AND date >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY), '%Y%m%d')
    ) t
    WHERE rn = 1
),
order_detail_dedup AS (
    SELECT oms_order_id, proposal_id
    FROM (
        SELECT id, oms_order_id, proposal_id,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.order_detail
        WHERE modified_on >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
          AND date >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY), '%Y%m%d')
    ) t
    WHERE rn = 1
),
order_item_dedup AS (
    SELECT oms_order_id, oms_item_id, price, status, created_on
    FROM (
        SELECT id, oms_order_id, oms_item_id, price, status, created_on,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn
        FROM glue_catalog.motor_proposal_3.order_item
        WHERE modified_on >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
          AND date >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY), '%Y%m%d')
    ) t
    WHERE rn = 1
),
policy_purchases AS (
    SELECT p.vehicle_type AS product,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR) AS customer_id,
        DATE(MIN(oi.created_on)) AS purchase_date,
        p.proposal_id, oi.oms_item_id,
        MAX(oi.price) AS premium,
        MAX(CASE WHEN oi.status IN ('issued', 'policy_pdf_generated') THEN 1 ELSE 0 END) AS issued_flag
    FROM order_item_dedup oi
    JOIN order_detail_dedup od ON oi.oms_order_id = od.oms_order_id
    JOIN proposal_dedup p ON p.proposal_id = od.proposal_id
    WHERE p.coverage_type IN ('comprehensive_1y_1y', 'own_damage_1y', 'third_party_1y')
      AND oi.created_on >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
    GROUP BY p.vehicle_type, oi.oms_item_id,
        CAST(COALESCE(p.created_by, p.owned_by) AS VARCHAR), p.proposal_id
    HAVING DATE(MIN(oi.created_on)) >= '${date}'
       AND DATE(MIN(oi.created_on)) < '${nextDate}'
),
cc_data AS (
    SELECT c.customer_id, c.agent, c.created_on, c.talk_duration
    FROM glue_catalog.recent_search_partition.enser_callback_data c
    WHERE c.service IN ('Fresh_Car', 'Renewal_Car', 'four_wheeler')
      AND c.customer_id NOT LIKE 'NA'
      AND c.call_type IN ('Outbound', 'CallBack', 'Manual')
      AND (c.source IS NULL OR c.source IN ('enser', 'reliable'))
      AND c.date >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 110 DAY), '%Y%m%d')
      AND c.created_on >= DATE_SUB(CURRENT_DATE(), INTERVAL 110 DAY)
      AND LOWER(c.agent) NOT IN ('no agent')
      AND CAST(c.customer_id AS VARCHAR) IN (SELECT DISTINCT customer_id FROM policy_purchases)
),
daily_calls AS (
    SELECT CAST(c.customer_id AS VARCHAR) AS customer_id, c.agent,
        DATE(c.created_on) AS call_date,
        SUM(
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 1), '') AS INT), 0) * 3600 +
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 2), '') AS INT), 0) * 60 +
            IFNULL(CAST(NULLIF(SPLIT_PART(c.talk_duration, ':', 3), '') AS INT), 0)
        ) AS daily_talk_seconds
    FROM cc_data c
    GROUP BY CAST(c.customer_id AS VARCHAR), c.agent, DATE(c.created_on)
),
cumulative_calls AS (
    SELECT cc.*, p.proposal_id, p.oms_item_id, p.purchase_date,
        SUM(CASE WHEN cc.call_date <= p.purchase_date THEN cc.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY cc.customer_id, p.proposal_id) AS cumulative_talk_seconds,
        SUM(CASE WHEN cc.call_date <= p.purchase_date THEN cc.daily_talk_seconds ELSE 0 END)
            OVER (PARTITION BY cc.customer_id, cc.agent, p.proposal_id) AS cumulative_talk_seconds_agent
    FROM daily_calls cc
    JOIN policy_purchases p ON cc.customer_id = p.customer_id
),
attribution_ranking AS (
    SELECT cc.*,
        CASE WHEN cc.cumulative_talk_seconds >= 30
          AND cc.call_date <= cc.purchase_date
          AND DATEDIFF(cc.purchase_date, cc.call_date) BETWEEN 0 AND 45
          THEN 1 ELSE 0 END AS attribution_eligible,
        ROW_NUMBER() OVER (
          PARTITION BY cc.customer_id, cc.proposal_id, cc.oms_item_id
          ORDER BY CASE WHEN cc.call_date <= cc.purchase_date
            AND DATEDIFF(cc.purchase_date, cc.call_date) BETWEEN 0 AND 45
            THEN cc.cumulative_talk_seconds_agent ELSE NULL END DESC
        ) AS agent_rank
    FROM cumulative_calls cc
),
conversions AS (
    SELECT DISTINCT customer_id
    FROM attribution_ranking
    WHERE attribution_eligible = 1 AND agent_rank = 1
),
raw_calls AS (
    SELECT CAST(customer_id AS VARCHAR) AS customer_id,
        disposition1, disposition2, disposition3, talk_duration
    FROM glue_catalog.recent_search_partition.enser_callback_data
    WHERE (source = 'enser' OR source IS NULL)
      AND customer_id <> 'NA'
      AND date >= DATE_FORMAT(CAST('${date}' AS DATE), '%Y%m%d')
      AND date < DATE_FORMAT(CAST('${nextDate}' AS DATE), '%Y%m%d')
      AND created_on >= '${date} 00:00:00'
      AND created_on < '${nextDate} 00:00:00'
)
SELECT
    COUNT(*) AS cc_sent,
    SUM(CASE WHEN COALESCE(disposition1, '') <> ''
      OR COALESCE(disposition2, '') <> '' OR COALESCE(disposition3, '') <> ''
      THEN 1 ELSE 0 END) AS cc_attempted,
    SUM(CASE WHEN
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 1), '') AS INT), 0) * 3600 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 2), '') AS INT), 0) * 60 +
      IFNULL(CAST(NULLIF(SPLIT_PART(talk_duration, ':', 3), '') AS INT), 0) > 0
      THEN 1 ELSE 0 END) AS cc_connected,
    COUNT(DISTINCT CASE WHEN cv.customer_id IS NOT NULL THEN r.customer_id END) AS cc_converted
FROM raw_calls r
LEFT JOIN conversions cv ON r.customer_id = cv.customer_id`;
}
