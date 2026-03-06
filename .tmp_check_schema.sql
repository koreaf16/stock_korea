whenever sqlerror exit sql.sqlcode;
connect stock_korea/Gnttkak1!@192.168.0.120:1521/AI_DB
set pagesize 200 linesize 240 trimspool on;
column table_name format a32
column partitioned format a12
column index_name format a24
column locality format a10
prompt === TABLES ===
select table_name, partitioned from user_tables where table_name in (
  'TB_ZONE0_EVENT_RAW','TB_ZONE1_TECHNICAL_LOG','TB_STOCK_FUNDAMENTAL','TB_ZONE3_PATTERN_LIBRARY','TB_ZONE4_MADNESS_LOG','TB_ZONE5_DECISION_LOG','TB_TRADE_HISTORY'
) order by table_name;
prompt === INDEXES ===
select index_name, table_name, locality from user_part_indexes where table_name in (
  'TB_ZONE0_EVENT_RAW','TB_ZONE1_TECHNICAL_LOG','TB_ZONE4_MADNESS_LOG','TB_ZONE5_DECISION_LOG','TB_TRADE_HISTORY'
) order by table_name, index_name;
prompt === VECTOR INDEXES ===
select index_name, table_name, index_type from user_indexes where index_name in ('IX_Z3_PATTERN_VEC','IX_Z6_TRADE_VEC') order by index_name;
exit;
