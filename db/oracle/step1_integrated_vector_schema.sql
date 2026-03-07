set define off;
set serveroutput on;
set feedback on;

prompt [DB INIT] Step1 integrated vector schema start

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z2_DISCLOSURE_VEC';
  if v_count > 0 then
    execute immediate 'drop index IX_Z2_DISCLOSURE_VEC';
    dbms_output.put_line('dropped legacy index IX_Z2_DISCLOSURE_VEC');
  else
    dbms_output.put_line('legacy index IX_Z2_DISCLOSURE_VEC not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z2_FIN_SIG_VEC';
  if v_count > 0 then
    execute immediate 'drop index IX_Z2_FIN_SIG_VEC';
    dbms_output.put_line('dropped legacy index IX_Z2_FIN_SIG_VEC');
  else
    dbms_output.put_line('legacy index IX_Z2_FIN_SIG_VEC not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z3_PATTERN_VEC';
  if v_count > 0 then
    execute immediate 'drop index IX_Z3_PATTERN_VEC';
    dbms_output.put_line('dropped legacy index IX_Z3_PATTERN_VEC');
  else
    dbms_output.put_line('legacy index IX_Z3_PATTERN_VEC not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z3_MICRO_VEC_HNSW';
  if v_count > 0 then
    execute immediate 'drop index IX_Z3_MICRO_VEC_HNSW';
    dbms_output.put_line('dropped legacy index IX_Z3_MICRO_VEC_HNSW');
  else
    dbms_output.put_line('legacy index IX_Z3_MICRO_VEC_HNSW not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z3_MACRO_VEC_IVF';
  if v_count > 0 then
    execute immediate 'drop index IX_Z3_MACRO_VEC_IVF';
    dbms_output.put_line('dropped legacy index IX_Z3_MACRO_VEC_IVF');
  else
    dbms_output.put_line('legacy index IX_Z3_MACRO_VEC_IVF not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z6_TRADE_VEC';
  if v_count > 0 then
    execute immediate 'drop index IX_Z6_TRADE_VEC';
    dbms_output.put_line('dropped legacy index IX_Z6_TRADE_VEC');
  else
    dbms_output.put_line('legacy index IX_Z6_TRADE_VEC not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE2_FUNDAMENTAL'
     and column_name = 'DISCLOSURE_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_ZONE2_FUNDAMENTAL drop column DISCLOSURE_VECTOR';
    dbms_output.put_line('dropped column TB_ZONE2_FUNDAMENTAL.DISCLOSURE_VECTOR');
  else
    dbms_output.put_line('column TB_ZONE2_FUNDAMENTAL.DISCLOSURE_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE3_PATTERN_LIBRARY'
     and column_name = 'MACRO_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_ZONE3_PATTERN_LIBRARY drop column MACRO_VECTOR';
    dbms_output.put_line('dropped column TB_ZONE3_PATTERN_LIBRARY.MACRO_VECTOR');
  else
    dbms_output.put_line('column TB_ZONE3_PATTERN_LIBRARY.MACRO_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE3_PATTERN_LIBRARY'
     and column_name = 'MICRO_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_ZONE3_PATTERN_LIBRARY drop column MICRO_VECTOR';
    dbms_output.put_line('dropped column TB_ZONE3_PATTERN_LIBRARY.MICRO_VECTOR');
  else
    dbms_output.put_line('column TB_ZONE3_PATTERN_LIBRARY.MICRO_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE2_FUNDAMENTAL'
     and column_name = 'FINANCIAL_SIGNATURE_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_ZONE2_FUNDAMENTAL drop column FINANCIAL_SIGNATURE_VECTOR';
    dbms_output.put_line('dropped column TB_ZONE2_FUNDAMENTAL.FINANCIAL_SIGNATURE_VECTOR');
  else
    dbms_output.put_line('column TB_ZONE2_FUNDAMENTAL.FINANCIAL_SIGNATURE_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE3_PATTERN_LIBRARY'
     and column_name = 'PATTERN_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_ZONE3_PATTERN_LIBRARY drop column PATTERN_VECTOR';
    dbms_output.put_line('dropped column TB_ZONE3_PATTERN_LIBRARY.PATTERN_VECTOR');
  else
    dbms_output.put_line('column TB_ZONE3_PATTERN_LIBRARY.PATTERN_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*)
    into v_count
    from user_tab_cols
   where table_name = 'TB_TRADE_HISTORY'
     and column_name = 'HISTORY_VECTOR';
  if v_count > 0 then
    execute immediate 'alter table TB_TRADE_HISTORY drop column HISTORY_VECTOR';
    dbms_output.put_line('dropped column TB_TRADE_HISTORY.HISTORY_VECTOR');
  else
    dbms_output.put_line('column TB_TRADE_HISTORY.HISTORY_VECTOR not found');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_tables where table_name = 'TB_ZONE1_TICK_RAW';
  if v_count = 0 then
    execute immediate q'[
      create table TB_ZONE1_TICK_RAW (
        event_ts         timestamp(6) not null,
        tick_id          number generated by default on null as identity,
        symbol           varchar2(12) not null,
        last_price       number(12,4) not null,
        trade_volume     number(18,4) default 0 not null,
        acc_trade_value  number(18,2),
        bid_price_1      number(12,4),
        ask_price_1      number(12,4),
        source           varchar2(24) default 'KIS' not null,
        payload_json     clob,
        created_at       timestamp(6) default systimestamp not null,
        constraint PK_TB_Z1_TICK_RAW primary key (event_ts, tick_id) using index local
      )
      partition by range (event_ts)
      interval (numtodsinterval(1, 'DAY'))
      (
        partition P_Z1_TICK_BOOT values less than (timestamp '2026-01-01 00:00:00')
      )
    ]';
    dbms_output.put_line('created table TB_ZONE1_TICK_RAW');
  else
    dbms_output.put_line('table TB_ZONE1_TICK_RAW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z1_TICK_SYM_TS';
  if v_count = 0 then
    execute immediate 'create index IX_Z1_TICK_SYM_TS on TB_ZONE1_TICK_RAW(symbol, event_ts) local';
    dbms_output.put_line('created index IX_Z1_TICK_SYM_TS');
  else
    dbms_output.put_line('index IX_Z1_TICK_SYM_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_tables where table_name = 'TB_ZONE3_CANDLE_RAW';
  if v_count = 0 then
    execute immediate q'[
      create table TB_ZONE3_CANDLE_RAW (
        candle_ts      timestamp(6) not null,
        candle_id      number generated by default on null as identity,
        symbol         varchar2(12) not null,
        interval_sec   number(4) default 60 not null,
        open_price     number(12,4) not null,
        high_price     number(12,4) not null,
        low_price      number(12,4) not null,
        close_price    number(12,4) not null,
        volume         number(18,4) default 0 not null,
        notional       number(18,2),
        source         varchar2(24) default 'ORCHESTRATOR' not null,
        payload_json   clob,
        created_at     timestamp(6) default systimestamp not null,
        constraint PK_TB_Z3_CANDLE_RAW primary key (candle_ts, candle_id) using index local,
        constraint CK_Z3_CANDLE_OHLC check (
          high_price >= greatest(open_price, close_price)
          and low_price <= least(open_price, close_price)
        )
      )
      partition by range (candle_ts)
      interval (numtodsinterval(1, 'DAY'))
      (
        partition P_Z3_CANDLE_BOOT values less than (timestamp '2026-01-01 00:00:00')
      )
    ]';
    dbms_output.put_line('created table TB_ZONE3_CANDLE_RAW');
  else
    dbms_output.put_line('table TB_ZONE3_CANDLE_RAW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z3_CANDLE_SYM_TS';
  if v_count = 0 then
    execute immediate 'create index IX_Z3_CANDLE_SYM_TS on TB_ZONE3_CANDLE_RAW(symbol, candle_ts) local';
    dbms_output.put_line('created index IX_Z3_CANDLE_SYM_TS');
  else
    dbms_output.put_line('index IX_Z3_CANDLE_SYM_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_tables where table_name = 'TB_ZONE4_NEWS_RAW';
  if v_count = 0 then
    execute immediate q'[
      create table TB_ZONE4_NEWS_RAW (
        news_ts          timestamp(6) not null,
        news_id          number generated by default on null as identity,
        symbol           varchar2(12),
        source           varchar2(40) not null,
        headline         varchar2(1000) not null,
        body_text        clob,
        news_url         varchar2(1000),
        lang_code        varchar2(8) default 'ko' not null,
        sentiment_score  number(6,3),
        payload_json     clob,
        created_at       timestamp(6) default systimestamp not null,
        constraint PK_TB_Z4_NEWS_RAW primary key (news_ts, news_id) using index local
      )
      partition by range (news_ts)
      interval (numtodsinterval(1, 'DAY'))
      (
        partition P_Z4_NEWS_BOOT values less than (timestamp '2026-01-01 00:00:00')
      )
    ]';
    dbms_output.put_line('created table TB_ZONE4_NEWS_RAW');
  else
    dbms_output.put_line('table TB_ZONE4_NEWS_RAW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'NEWS_TS_MS';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (NEWS_TS_MS number(13))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.NEWS_TS_MS');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.NEWS_TS_MS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'SOURCE_CLASS';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (SOURCE_CLASS varchar2(20))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.SOURCE_CLASS');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.SOURCE_CLASS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'SOURCE_SCORE';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (SOURCE_SCORE number(6,4))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.SOURCE_SCORE');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.SOURCE_SCORE already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'KEYWORDS_JSON';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (KEYWORDS_JSON clob)';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.KEYWORDS_JSON');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.KEYWORDS_JSON already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'KEYWORD_STRENGTH';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (KEYWORD_STRENGTH number(8,6))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.KEYWORD_STRENGTH');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.KEYWORD_STRENGTH already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'SPIKE_TS';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (SPIKE_TS timestamp(6))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.SPIKE_TS');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.SPIKE_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'REACTION_LATENCY_MS';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (REACTION_LATENCY_MS number(12))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.REACTION_LATENCY_MS');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.REACTION_LATENCY_MS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'TEMPO_LABEL';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (TEMPO_LABEL varchar2(24))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.TEMPO_LABEL');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.TEMPO_LABEL already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'SHOCK_SCORE';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (SHOCK_SCORE number(6,3))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.SHOCK_SCORE');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.SHOCK_SCORE already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'SECTOR_COUPLING_IDX';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (SECTOR_COUPLING_IDX number(8,6))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.SECTOR_COUPLING_IDX');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.SECTOR_COUPLING_IDX already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count
    from user_tab_cols
   where table_name = 'TB_ZONE4_NEWS_RAW'
     and column_name = 'LLM_POTENTIAL_SCORE';
  if v_count = 0 then
    execute immediate 'alter table TB_ZONE4_NEWS_RAW add (LLM_POTENTIAL_SCORE number(6,3))';
    dbms_output.put_line('added column TB_ZONE4_NEWS_RAW.LLM_POTENTIAL_SCORE');
  else
    dbms_output.put_line('column TB_ZONE4_NEWS_RAW.LLM_POTENTIAL_SCORE already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z4_NEWS_SYM_TS';
  if v_count = 0 then
    execute immediate 'create index IX_Z4_NEWS_SYM_TS on TB_ZONE4_NEWS_RAW(symbol, news_ts) local';
    dbms_output.put_line('created index IX_Z4_NEWS_SYM_TS');
  else
    dbms_output.put_line('index IX_Z4_NEWS_SYM_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_Z4_NEWS_TEMPO_TS';
  if v_count = 0 then
    execute immediate 'create index IX_Z4_NEWS_TEMPO_TS on TB_ZONE4_NEWS_RAW(symbol, tempo_label, news_ts) local';
    dbms_output.put_line('created index IX_Z4_NEWS_TEMPO_TS');
  else
    dbms_output.put_line('index IX_Z4_NEWS_TEMPO_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_tables where table_name = 'TB_INTEGRATED_VECTOR_STATION';
  if v_count = 0 then
    execute immediate q'[
      create table TB_INTEGRATED_VECTOR_STATION (
        event_id      number generated by default on null as identity,
        symbol        varchar2(12) not null,
        event_ts      timestamp(6) not null,
        z1_tech_vec   vector(128, FLOAT32) not null,
        z2_fund_vec   vector(256, FLOAT32) not null,
        z3_chart_vec  vector(512, FLOAT32) not null,
        z4_sent_vec   vector(768, FLOAT32) not null,
        profit_rate   number(9,4) default null,
        created_at    timestamp(6) default systimestamp not null,
        updated_at    timestamp(6) default systimestamp not null,
        constraint PK_TB_INT_VEC_STATION primary key (event_id)
      )
    ]';
    dbms_output.put_line('created table TB_INTEGRATED_VECTOR_STATION');
  else
    dbms_output.put_line('table TB_INTEGRATED_VECTOR_STATION already exists');
  end if;
end;
/

declare
  v_enabled number := 0;
begin
  select count(*)
    into v_enabled
    from user_tables
   where table_name = 'TB_INTEGRATED_VECTOR_STATION'
     and inmemory = 'ENABLED';

  if v_enabled = 0 then
    begin
      execute immediate 'alter table TB_INTEGRATED_VECTOR_STATION inmemory memcompress for query low priority high';
      dbms_output.put_line('enabled inmemory on TB_INTEGRATED_VECTOR_STATION');
    exception
      when others then
        dbms_output.put_line('skip inmemory on TB_INTEGRATED_VECTOR_STATION: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('inmemory already enabled on TB_INTEGRATED_VECTOR_STATION');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_IVS_SYM_EVT_TS';
  if v_count = 0 then
    execute immediate 'create index IX_IVS_SYM_EVT_TS on TB_INTEGRATED_VECTOR_STATION(symbol, event_ts)';
    dbms_output.put_line('created index IX_IVS_SYM_EVT_TS');
  else
    dbms_output.put_line('index IX_IVS_SYM_EVT_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_IVS_Z1_TECH_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_IVS_Z1_TECH_HNSW
        on TB_INTEGRATED_VECTOR_STATION(z1_tech_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_IVS_Z1_TECH_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_IVS_Z1_TECH_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_IVS_Z1_TECH_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_IVS_Z2_FUND_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_IVS_Z2_FUND_HNSW
        on TB_INTEGRATED_VECTOR_STATION(z2_fund_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_IVS_Z2_FUND_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_IVS_Z2_FUND_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_IVS_Z2_FUND_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_IVS_Z3_CHART_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_IVS_Z3_CHART_HNSW
        on TB_INTEGRATED_VECTOR_STATION(z3_chart_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_IVS_Z3_CHART_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_IVS_Z3_CHART_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_IVS_Z3_CHART_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_IVS_Z4_SENT_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_IVS_Z4_SENT_HNSW
        on TB_INTEGRATED_VECTOR_STATION(z4_sent_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_IVS_Z4_SENT_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_IVS_Z4_SENT_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_IVS_Z4_SENT_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_tables where table_name = 'TB_PATTERN_LIBRARY';
  if v_count = 0 then
    execute immediate q'[
      create table TB_PATTERN_LIBRARY (
        learned_at       timestamp(6) not null,
        pattern_id       varchar2(64) not null,
        source_event_id  number not null,
        symbol           varchar2(12) not null,
        event_ts         timestamp(6) not null,
        profit_rate      number(9,4) not null,
        outcome_label    varchar2(12) not null,
        z1_tech_vec      vector(128, FLOAT32) not null,
        z2_fund_vec      vector(256, FLOAT32) not null,
        z3_chart_vec     vector(512, FLOAT32) not null,
        z4_sent_vec      vector(768, FLOAT32) not null,
        archive_json     clob,
        review_diary     clob,
        created_at       timestamp(6) default systimestamp not null,
        updated_at       timestamp(6) default systimestamp not null,
        constraint PK_TB_PATTERN_LIBRARY primary key (learned_at, pattern_id) using index local,
        constraint CK_TB_PATTERN_OUTCOME check (outcome_label in ('SUCCESS', 'FAILURE', 'BREAKEVEN'))
      )
      partition by range (learned_at)
      interval (numtoyminterval(1, 'MONTH'))
      (
        partition P_PATTERN_LIB_BOOT values less than (timestamp '2026-01-01 00:00:00')
      )
    ]';
    dbms_output.put_line('created table TB_PATTERN_LIBRARY');
  else
    dbms_output.put_line('table TB_PATTERN_LIBRARY already exists');
  end if;
end;
/

declare
  v_enabled number := 0;
begin
  select count(*)
    into v_enabled
    from user_tables
   where table_name = 'TB_PATTERN_LIBRARY'
     and inmemory = 'ENABLED';

  if v_enabled = 0 then
    begin
      execute immediate 'alter table TB_PATTERN_LIBRARY inmemory memcompress for query low priority medium';
      dbms_output.put_line('enabled inmemory on TB_PATTERN_LIBRARY');
    exception
      when others then
        dbms_output.put_line('skip inmemory on TB_PATTERN_LIBRARY: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('inmemory already enabled on TB_PATTERN_LIBRARY');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_LIB_SYM_TS';
  if v_count = 0 then
    execute immediate 'create index IX_PAT_LIB_SYM_TS on TB_PATTERN_LIBRARY(symbol, learned_at) local';
    dbms_output.put_line('created index IX_PAT_LIB_SYM_TS');
  else
    dbms_output.put_line('index IX_PAT_LIB_SYM_TS already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_LIB_SRC_EVT';
  if v_count = 0 then
    execute immediate 'create index IX_PAT_LIB_SRC_EVT on TB_PATTERN_LIBRARY(source_event_id, learned_at) local';
    dbms_output.put_line('created index IX_PAT_LIB_SRC_EVT');
  else
    dbms_output.put_line('index IX_PAT_LIB_SRC_EVT already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_Z1_TECH_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_PAT_Z1_TECH_HNSW
        on TB_PATTERN_LIBRARY(z1_tech_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_PAT_Z1_TECH_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_PAT_Z1_TECH_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_PAT_Z1_TECH_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_Z2_FUND_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_PAT_Z2_FUND_HNSW
        on TB_PATTERN_LIBRARY(z2_fund_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_PAT_Z2_FUND_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_PAT_Z2_FUND_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_PAT_Z2_FUND_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_Z3_CHART_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_PAT_Z3_CHART_HNSW
        on TB_PATTERN_LIBRARY(z3_chart_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_PAT_Z3_CHART_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_PAT_Z3_CHART_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_PAT_Z3_CHART_HNSW already exists');
  end if;
end;
/

declare
  v_count number := 0;
begin
  select count(*) into v_count from user_indexes where index_name = 'IX_PAT_Z4_SENT_HNSW';
  if v_count = 0 then
    begin
      execute immediate q'[
        create vector index IX_PAT_Z4_SENT_HNSW
        on TB_PATTERN_LIBRARY(z4_sent_vec)
        organization inmemory neighbor graph
        distance cosine
        with target accuracy 95
      ]';
      dbms_output.put_line('created vector index IX_PAT_Z4_SENT_HNSW');
    exception
      when others then
        dbms_output.put_line('skip IX_PAT_Z4_SENT_HNSW: ' || sqlerrm);
    end;
  else
    dbms_output.put_line('index IX_PAT_Z4_SENT_HNSW already exists');
  end if;
end;
/

prompt [DB INIT] Step1 integrated vector schema complete
