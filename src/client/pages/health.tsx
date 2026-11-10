// Health page projects the independent health hook state; polling and cleanup belong to hooks.
// Health page: invariants, warnings, leases and open intents.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { useHealth } from '../hooks/use-health.ts';
import { warningText } from '../model/labels.ts';
import { Button, ErrorState, LoadingState, Section, StatTile } from '../components/primitives.tsx';
import { cx, formatClock, formatDateTime, shortId } from '../utils/format.ts';
import { IconCheck, IconRefresh, IconWarning } from '../components/icons.tsx';

export interface HealthPaneProps {
  projectId?: string;
  initial?: { health?: View.Health };
}







export function HealthPane(props: HealthPaneProps) {
  const projectId = props.projectId;
  const initial = props.initial || {};
  const state = useHealth(projectId, initial);
  const health = state.health as View.Health, error = state.error, updatedAt = state.updatedAt, load = state.load;

  if (error) return <ErrorState message={error} block={true} action={<Button size="sm" onClick={load}>{'重试'}</Button>} />;
  if (!health) return <LoadingState label="健康信息加载中" />;

  const checks = health.checks || [];
  const warnings = health.warnings || [];
  const leases = health.leases || [];
  const intents = health.intents || [];
  const failedChecks = checks.filter(function(check) { return !check.ok; });

  return <div className="pb-page">
    <div className="pb-health-head">
      <h2 className="pb-health-head__title">{'系统健康'}</h2>
      <div className="pb-health-head__meta">
        <span>{'最后提交 ' + formatDateTime(health.lastAt)}</span>
        {updatedAt ? <span>{'刷新于 ' + formatClock(updatedAt)}</span> : null}
        <Button size="sm" variant="ghost" icon={IconRefresh} onClick={load}>{'刷新'}</Button>
      </div>
    </div>
    <div className="pb-stats pb-stats--health">
      <StatTile tone="neutral" value={health.seq} label="日志序号" />
      <StatTile tone={health.hashChain === 'ok' ? 'success' : 'danger'} value={health.hashChain === 'ok' ? '正常' : String(health.hashChain)} label="哈希链" />
      <StatTile tone={health.readOnly ? 'warn' : 'neutral'} value={health.readOnly ? '是' : '否'} label="只读" />
      <StatTile tone={warnings.length ? 'danger' : 'success'} value={warnings.length} label="告警" />
      <StatTile tone={leases.length ? 'accent' : 'neutral'} value={leases.length} label="活跃租约" />
      <StatTile tone={intents.length ? 'warn' : 'neutral'} value={intents.length} label="未关闭意图" />
    </div>
    <Section title="不变量检查" id="pb-sec-checks" aside={<span className="pb-section__count">{(checks.length - failedChecks.length) + '/' + checks.length + ' 通过'}</span>}>
      {checks.length === 0
        ? <p className="pb-hint">{'没有检查项。'}</p>
        : <ul className="pb-checks">
          {checks.map(function(check, index) {
            return <li key={check.name + '-' + index} className={cx('pb-check', check.ok ? 'pb-check--ok' : 'pb-check--bad')}>
              <span className="pb-check__mark" aria-hidden="true">{check.ok ? <IconCheck size={12} /> : <IconWarning size={12} />}</span>
              <span className="pb-check__name pb-mono">{check.name}</span>
              {check.detail ? <span className="pb-check__detail">{warningText(check.detail)}</span> : null}
            </li>;
          })}
        </ul>}
    </Section>
    <Section title="告警" id="pb-sec-warnings" aside={<span className="pb-section__count">{String(warnings.length)}</span>}>
      {warnings.length === 0
        ? <p className="pb-hint">{'没有告警。'}</p>
        : <ul className="pb-warnings">
          {warnings.map(function(warning, index) {
            return <li key={index} className="pb-warning">
              <IconWarning size={13} />
              <span>{warningText(warning)}</span>
            </li>;
          })}
        </ul>}
    </Section>
    <Section title="租约" id="pb-sec-leases" aside={<span className="pb-section__count">{String(leases.length)}</span>}>
      {leases.length === 0
        ? <p className="pb-hint">{'没有活跃租约。'}</p>
        : <ul className="pb-leases">
          {leases.map(function(lease) {
            const expired = Date.parse(lease.expiresAt || '') <= Date.now();
            return <li key={lease.taskId} className={cx('pb-lease', expired ? 'pb-lease--expired' : null)}>
              <span className="pb-lease__task pb-mono">{lease.taskId}</span>
              <span className="pb-lease__session pb-mono">{shortId(lease.sessionId, 16)}</span>
              <span className="pb-lease__token">{'令牌 ' + lease.token}</span>
              <span className="pb-lease__time">{expired ? '已过期' : '至 ' + formatDateTime(lease.expiresAt)}</span>
            </li>;
          })}
        </ul>}
    </Section>
    <Section title="未关闭意图" id="pb-sec-intents" aside={<span className="pb-section__count">{String(intents.length)}</span>}>
      {intents.length === 0
        ? <p className="pb-hint">{'没有未关闭意图。'}</p>
        : <ul className="pb-intents">
          {intents.map(function(intent) {
            return <li key={intent.id} className="pb-intent">
              <span className="pb-intent__task pb-mono">{intent.taskId}</span>
              <span className="pb-intent__summary">{intent.summary}</span>
              {intent.startedAt ? <span className="pb-intent__time">{formatDateTime(intent.startedAt)}</span> : null}
            </li>;
          })}
        </ul>}
      {intents.length ? <p className="pb-hint">{'有未关闭意图通常意味着上一次执行崩溃了，需要先对账。'}</p> : null}
    </Section>
  </div>;
}
