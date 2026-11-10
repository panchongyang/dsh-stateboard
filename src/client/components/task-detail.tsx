// Task detail projects supplied acceptance, evidence and timeline; only local user actions invoke supplied callbacks or session adapters.
// Task detail: description, acceptance, evidence, linked assets and timeline.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { auditActorLabel, actorLabel, eventLabel, evidenceKindLabel, evidenceObservation } from '../model/labels.ts';
import { cx, formatDateTime, shortId } from '../utils/format.ts';
import { openSessionById } from '../model/session-jump.ts';
import { Badge, ProgressBar, Section } from './primitives.tsx';
import { IconCheck } from './icons.tsx';

export interface AuditDetailProps {
  audit?: View.Audit;
}
export interface TaskDetailProps {
  task: View.TaskDetail;
  acceptance?: View.AcceptanceItem[];
  evidence?: View.EvidenceItem[];
  linkedDocs?: View.Doc[];
  timeline?: View.TimelineEvent[];
  met?: number;
  notify?: View.Notify;
  onOpenDoc?: (id: string) => void;
  timelineOpen?: boolean;
  onToggleTimeline?: () => void;
}







export function AuditDetail(props: AuditDetailProps) {
  const audit = props.audit;
  if (!audit) return null;
  const by = audit.by || {};
  return <Section title="最近审计" id="pb-sec-audit">
    <p className="pb-prose">{auditActorLabel(audit) + ' · ' + (audit.verdict === 'pass' ? '通过' : '驳回')}</p>
    <p className="pb-hint">{'by.kind=' + (by.kind || '?') + ' · ' + (by.sessionId || by.agentId || 'human') + ' · ' + formatDateTime(audit.at)}</p>
    <p className="pb-prose">{audit.report || '未填写报告（人类可直接验收）'}</p>
    <ul className="pb-checks">
      {(audit.checklist || []).map(function(item, index) {
        return <li key={index}>{(item.ok ? '✓ ' : '× ') + item.item + (item.note ? ' — ' + item.note : '')}</li>;
      })}
    </ul>
    <p className="pb-hint pb-mono">{'证据 ' + ((audit.evidence && audit.evidence.count) || 0) + ' · digest ' + ((audit.evidence && audit.evidence.digest) || '—') + ' · task rev ' + audit.taskRev}</p>
    <ul className="pb-warnings">
      {(audit.warnings || []).map(function(warning, index) {
        return <li key={index} className="pb-warning">{typeof warning === 'string' ? warning : (warning.code || '') + ' ' + (warning.message || '')}</li>;
      })}
    </ul>
    <p className="pb-hint">{'这是验收者记录，不是系统对交付正确性的证明；项目板不重跑命令或测试。'}</p>
  </Section>;
}

export function TaskDetail(props: TaskDetailProps) {
  const task = props.task;
  const acceptance = props.acceptance || [];
  const evidence = props.evidence || [];
  const linkedDocs = props.linkedDocs || [];
  const timeline = props.timeline || [];
  const met = props.met || 0;
  const notify = props.notify || function() { };
  return [
    task.description ? <Section key="desc" title="描述" id="pb-sec-desc">
      <p className="pb-prose">{task.description}</p>
    </Section> : null,

    <Section key="accept" title="验收项" id="pb-sec-accept" aside={<span className="pb-section__count">{met + '/' + acceptance.length}</span>}>
      {acceptance.length === 0
        ? <p className="pb-hint">{'这个任务没有验收项。'}</p>
        : <div className="pb-overview">
          <ProgressBar value={acceptance.length ? met / acceptance.length : 0} tone={met === acceptance.length && acceptance.length > 0 ? 'success' : 'accent'} thin={true} label="验收完成度" />
          <ul className="pb-accept-list">
            {acceptance.map(function(item) {
              return <li key={item.id} className={cx('pb-accept', item.met ? 'pb-accept--met' : null)}>
                <span className="pb-accept__mark" aria-hidden="true">{item.met ? <IconCheck size={12} /> : null}</span>
                <span className="pb-accept__text">{item.text}</span>
                {(item.requiredKinds || []).map(function(kind) { return <Badge key={kind} tone="neutral">{evidenceKindLabel(kind)}</Badge>; })}
              </li>;
            })}
          </ul>
        </div>}
    </Section>,

    evidence.length ? <Section key="evidence" title="证据" id="pb-sec-evidence" aside={<span className="pb-section__count">{String(evidence.length)}</span>}>
      <ul className="pb-evidence-list">
        {evidence.map(function(item) {
          const observation = evidenceObservation(item);
          return <li key={item.id} className="pb-evidence">
            <Badge tone="neutral">{evidenceKindLabel(item.kind)}</Badge>
            <span className="pb-evidence__ref pb-mono">{item.ref}</span>
            {observation ? <Badge tone={observation.tone}>{observation.label}</Badge> : null}
            {item.summary ? <span className="pb-evidence__summary">{item.summary}</span> : null}
            {item.producedBy && item.producedBy.sessionId
              ? <button type="button" className="pb-session-link pb-session-link--sm" title={'跳到会话 ' + item.producedBy.sessionId} onClick={function() { openSessionById(item.producedBy!.sessionId!, notify); }}>{'来源会话'}</button>
              : null}
          </li>;
        })}
      </ul>
    </Section> : null,

    task.lastAudit ? <AuditDetail key="audit" audit={task.lastAudit} /> : null,

    (task.planRef || linkedDocs.length) ? <div key="assets" className="pb-assets">
      {task.planRef ? <span className="pb-assets__item">{'计划 ' + shortId(task.planRef.planId, 10) + ' v' + task.planRef.version}</span> : null}
      {linkedDocs.length ? <span className="pb-assets__item">
        {'关联 ' + linkedDocs.length + ' 篇文档'}
        {linkedDocs.map(function(doc) {
          return <button key={doc.id} type="button" className="pb-assets__doc" title={doc.id + ' r' + doc.rev} onClick={function() { if (props.onOpenDoc) props.onOpenDoc(doc.id!); }}>{doc.title}</button>;
        })}
      </span> : null}
    </div> : null,

    timeline.length ? <div key="timeline" className="pb-fold">
      <button type="button" className="pb-fold__head" aria-expanded={props.timelineOpen ? 'true' : 'false'} onClick={function() { props.onToggleTimeline!(); }}>{'时间线 · 最近 ' + timeline.length + ' 条 ' + (props.timelineOpen ? '▴' : '▾')}</button>
      {props.timelineOpen ? <ol className="pb-timeline">
        {timeline.slice().reverse().map(function(event, index) {
          return <li key={String(event.seq) + '-' + index} className="pb-timeline__item">
            <span className="pb-timeline__dot" aria-hidden="true" />
            <span className="pb-timeline__label">{eventLabel(event.type)}</span>
            <span className="pb-timeline__meta">{'#' + event.seq + ' · ' + actorLabel(event.actor && event.actor.kind) + (event.at ? ' · ' + formatDateTime(event.at) : '')}</span>
          </li>;
        })}
      </ol> : null}
    </div> : null,
  ];
}
