-- Zone3 Hybrid (Macro + Micro) schema for Oracle 26ai
-- Run after creating user/schema with enough tablespace quota.

begin
  execute immediate 'drop table TB_ZONE3_PATTERN_LIBRARY purge';
exception
  when others then
    if sqlcode != -942 then
      raise;
    end if;
end;
/

create table TB_ZONE3_PATTERN_LIBRARY (
  pattern_id        varchar2(96) not null,
  symbol            varchar2(16) not null,
  event_ts          timestamp(6) not null,
  event_date        date not null,
  event_type        varchar2(32) not null,
  ohlvc_json        clob not null,
  macro_vector      vector(256, float32) not null,
  micro_vector      vector(256, float32) not null,
  future_ret_1d     number(9,4),
  created_at        timestamp(6) default systimestamp not null,
  updated_at        timestamp(6) default systimestamp not null,
  constraint PK_TB_ZONE3_PATTERN_LIBRARY primary key (pattern_id)
)
partition by range (event_ts)
interval (numtoyminterval(1, 'MONTH'))
(
  partition P202401 values less than (timestamp '2024-02-01 00:00:00')
);
/

create index IX_Z3_SYMBOL_EVENT on TB_ZONE3_PATTERN_LIBRARY(symbol, event_date) local;
/

create index IX_Z3_EVENT_TYPE on TB_ZONE3_PATTERN_LIBRARY(event_type, event_ts) local;
/

-- HNSW local vector index for micro trajectory (tree-level nearest neighbor)
create vector index IX_Z3_MICRO_VEC_HNSW
on TB_ZONE3_PATTERN_LIBRARY(micro_vector)
organization neighbor partitions
distance cosine
with target accuracy 90
local;
/

-- IVF local vector index for macro regime filtering (forest-level nearest neighbor)
create vector index IX_Z3_MACRO_VEC_IVF
on TB_ZONE3_PATTERN_LIBRARY(macro_vector)
organization neighbor partitions
distance cosine
with target accuracy 85
local;
/

-- Optional stats refresh block (run after major bulk load)
begin
  dbms_stats.gather_table_stats(
    ownname => user,
    tabname => 'TB_ZONE3_PATTERN_LIBRARY',
    cascade => true,
    method_opt => 'FOR ALL COLUMNS SIZE AUTO'
  );
end;
/
