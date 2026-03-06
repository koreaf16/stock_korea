whenever sqlerror exit sql.sqlcode;
connect stock_korea/Gnttkak1!@192.168.0.120:1521/AI_DB
set pagesize 0 feedback off verify off heading off echo off;
select 'OK:' || to_char(1) from dual;
exit;
