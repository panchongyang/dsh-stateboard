// Task-operation form projections build payloads from supplied fields; the page owns allowed operations and command execution.
// Task composer: the four write-op forms (begin / submit / block / reconcile).
import React from 'react';
import type * as View from '../model/view-types.ts';
import { BLOCKER_CODES, EVIDENCE_KINDS, EVIDENCE_PLACEHOLDER, RECONCILE_LABELS, blockerLabel, evidenceKindLabel, reasonText } from '../model/labels.ts';
import { buildEvidence } from '../model/payloads.ts';
import { Button, Input, Select } from './primitives.tsx';

export interface TaskComposerProps {
  fields: View.ComposerFields;
  setters: View.ComposerSetters;
  opInfo: (name: string) => View.AllowedOp;
  busy?: boolean;
  act: (op: string, extra?: Record<string, unknown>) => void;
  composer?: string | null;
  onClose?: () => void;
  acceptance?: View.AcceptanceItem[];
  view?: View.TaskView;
}
export interface ComposerHeadProps {
  name: string;
  onClose?: () => void;
}
export interface BeginFormProps {
  fields: View.ComposerFields;
  setters: View.ComposerSetters;
  opInfo: (name: string) => View.AllowedOp;
  busy?: boolean;
  onClose?: () => void;
  onAct: (op: string, extra?: Record<string, unknown>) => void;
}
export interface SubmitFormProps {
  fields: View.ComposerFields;
  setters: View.ComposerSetters;
  opInfo: (name: string) => View.AllowedOp;
  busy?: boolean;
  acceptance?: View.AcceptanceItem[];
  onClose?: () => void;
  onSubmit: () => void;
}
export interface BlockFormProps {
  fields: View.ComposerFields;
  setters: View.ComposerSetters;
  opInfo: (name: string) => View.AllowedOp;
  busy?: boolean;
  onClose?: () => void;
  onAct: (op: string, extra?: Record<string, unknown>) => void;
}
export interface ReconcileFormProps {
  fields: View.ComposerFields;
  setters: View.ComposerSetters;
  opInfo: (name: string) => View.AllowedOp;
  busy?: boolean;
  onClose?: () => void;
  onReconcile: () => void;
}





/** Composer ids: only one is open at a time (P3). */
const COMPOSER_TITLES: Record<string, string> = { submit: '提交证据', block: '标记阻塞', reconcile: '对账' };

export function TaskComposer(props: TaskComposerProps) {
  const fields = props.fields;
  const setters = props.setters;
  const opInfo = props.opInfo;
  const busy = props.busy;

  function submitEvidence() {
    const ref = String(fields.evidenceRef || '').trim();
    if (!ref) return;
    props.act('submit', {
      evidence: [buildEvidence({ kind: fields.evidenceKind, ref, summary: fields.evidenceSummary, acceptanceId: fields.acceptanceId })],
      note: fields.note || undefined,
    });
  }

  function reconcile() {
    props.act('reconcile', {
      choice: fields.choice,
      note: fields.reconcileNote || '在界面中对账',
      evidence: fields.choice === 'completed' && String(fields.evidenceRef || '').trim()
        ? [buildEvidence({ kind: fields.evidenceKind, ref: fields.evidenceRef, summary: fields.evidenceSummary || '对账证据', acceptanceId: fields.acceptanceId })]
        : undefined,
    });
  }

  if (props.composer === 'begin') {
    return <BeginForm
      fields={fields}
      setters={setters}
      opInfo={opInfo}
      busy={busy}
      onAct={props.act}
      onClose={props.onClose}
    />;
  }
  if (props.composer === 'submit') {
    return <SubmitForm
      fields={fields}
      setters={setters}
      opInfo={opInfo}
      busy={busy}
      acceptance={props.acceptance}
      onSubmit={submitEvidence}
      onClose={props.onClose}
    />;
  }
  if (props.composer === 'block') {
    return <BlockForm
      fields={fields}
      setters={setters}
      opInfo={opInfo}
      busy={busy}
      onAct={props.act}
      onClose={props.onClose}
    />;
  }
  if (props.composer === 'reconcile') {
    return <ReconcileForm
      fields={fields}
      setters={setters}
      opInfo={opInfo}
      busy={busy}
      onReconcile={reconcile}
      onClose={props.onClose}
    />;
  }
  return null;
}

function ComposerHead(props: ComposerHeadProps) {
  return <div className="pb-composer__head">
    <span className="pb-composer__title">{COMPOSER_TITLES[props.name] || props.name}</span>
    <button type="button" className="pb-composer__close" aria-label="收起" title="收起 (Esc)" onClick={function() { props.onClose!(); }}>{'×'}</button>
  </div>;
}

function BeginForm(props: BeginFormProps) {
  const fields = props.fields;
  const setters = props.setters;
  const opInfo = props.opInfo;
  const busy = props.busy;
  return <div className="pb-composer">
    <ComposerHead name="begin" onClose={props.onClose} />
    <div className="pb-composer__body">
      <Input
        id="pb-begin-summary"
        label="开始前写一条意图（崩溃后靠它对账）"
        placeholder="准备做什么？"
        value={fields.beginSummary}
        onChange={function(event) { setters.setBeginSummary(event.target.value); }}
        hint={opInfo('begin').enabled ? '' : reasonText(opInfo('begin').reason)}
      />
      <div className="pb-composer__actions">
        <Button size="sm" onClick={function() { props.onClose!(); }}>{'取消'}</Button>
        <Button variant="primary" size="sm" disabled={busy || !opInfo('begin').enabled || String(fields.beginSummary).trim() === ''} title={opInfo('begin').enabled ? '' : reasonText(opInfo('begin').reason)} onClick={function() { props.onAct('begin', { summary: String(fields.beginSummary).trim() }); }}>{busy ? '提交中…' : '开始'}</Button>
      </div>
    </div>
  </div>;
}

function SubmitForm(props: SubmitFormProps) {
  const fields = props.fields;
  const setters = props.setters;
  const opInfo = props.opInfo;
  const busy = props.busy;
  const acceptance = props.acceptance || [];
  return <div className="pb-composer">
    <ComposerHead name="submit" onClose={props.onClose} />
    <div className="pb-composer__body">
      <Select id="pb-evidence-kind" label="证据类型" value={fields.evidenceKind} onChange={function(event) { setters.setEvidenceKind(event.target.value); }} options={EVIDENCE_KINDS.map(function(kind) { return { value: kind, label: evidenceKindLabel(kind) }; })} />
      <Input
        id="pb-evidence-ref"
        label="引用"
        mono={true}
        placeholder={EVIDENCE_PLACEHOLDER[fields.evidenceKind] || ''}
        value={fields.evidenceRef}
        onChange={function(event) { setters.setEvidenceRef(event.target.value); }}
        onKeyDown={function(event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); props.onSubmit(); }
        }}
      />
      <Select id="pb-evidence-acceptance" label="归属验收项" value={fields.acceptanceId} onChange={function(event) { setters.setAcceptanceId(event.target.value); }} options={[{ value: '', label: '不指定' }].concat(acceptance.map(function(item) {
        return { value: item.id!, label: (item.met ? '✓ ' : '○ ') + item.text.slice(0, 24) };
      }))} />
      <Input id="pb-evidence-summary" label="摘要" placeholder="这条证据说明了什么？" value={fields.evidenceSummary} onChange={function(event) { setters.setEvidenceSummary(event.target.value); }} />
      <Input id="pb-submit-note" label="备注" placeholder="可选" value={fields.note} onChange={function(event) { setters.setNote(event.target.value); }} />
      <div className="pb-composer__actions">
        <Button size="sm" onClick={function() { props.onClose!(); }}>{'取消'}</Button>
        <Button variant="primary" size="sm" disabled={busy || !opInfo('submit').enabled || String(fields.evidenceRef).trim() === ''} title={opInfo('submit').enabled ? '' : reasonText(opInfo('submit').reason)} onClick={props.onSubmit}>{busy ? '提交中…' : '提交证据'}</Button>
      </div>
    </div>
  </div>;
}

function BlockForm(props: BlockFormProps) {
  const fields = props.fields;
  const setters = props.setters;
  const opInfo = props.opInfo;
  const busy = props.busy;
  return <div className="pb-composer">
    <ComposerHead name="block" onClose={props.onClose} />
    <div className="pb-composer__body">
      <Select id="pb-block-code" label="阻塞原因" value={fields.blockCode} onChange={function(event) { setters.setBlockCode(event.target.value); }} options={BLOCKER_CODES.map(function(code) { return { value: code, label: blockerLabel(code) }; })} />
      <Input id="pb-block-note" label="说明" placeholder="缺什么、等谁？" value={fields.blockNote} onChange={function(event) { setters.setBlockNote(event.target.value); }} />
      <div className="pb-composer__actions">
        <Button size="sm" onClick={function() { props.onClose!(); }}>{'取消'}</Button>
        <Button variant="danger" size="sm" disabled={busy || !opInfo('block').enabled} title={reasonText(opInfo('block').reason)} onClick={function() { props.onAct('block', { code: fields.blockCode, note: fields.blockNote || '在界面中标记阻塞' }); }}>{'标记阻塞'}</Button>
      </div>
    </div>
  </div>;
}

function ReconcileForm(props: ReconcileFormProps) {
  const fields = props.fields;
  const setters = props.setters;
  const opInfo = props.opInfo;
  const busy = props.busy;
  return <div className="pb-composer">
    <ComposerHead name="reconcile" onClose={props.onClose} />
    <div className="pb-composer__body">
      <Select id="pb-reconcile-choice" label="对账结果" value={fields.choice} onChange={function(event) { setters.setChoice(event.target.value); }} options={['resume', 'completed', 'discard'].map(function(item) { return { value: item, label: RECONCILE_LABELS[item] }; })} />
      <Input id="pb-reconcile-note" label="说明" placeholder="崩溃前做到哪一步？" value={fields.reconcileNote} onChange={function(event) { setters.setReconcileNote(event.target.value); }} />
      <div className="pb-composer__actions">
        <Button size="sm" onClick={function() { props.onClose!(); }}>{'取消'}</Button>
        <Button variant="primary" size="sm" disabled={busy || !opInfo('reconcile').enabled} title={reasonText(opInfo('reconcile').reason)} onClick={props.onReconcile}>{'对账'}</Button>
      </div>
    </div>
  </div>;
}
