// Shared SVG glyphs project size and children only; no page state or transport dependencies.
import React from 'react';
import type * as View from '../model/view-types.ts';

export interface IconBoxProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconBoardProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconDocsProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconPlanProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconHealthProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconRefreshProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconPlusProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconCloseProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconSearchProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconCheckProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconWarningProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconLockProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconPlayProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconArrowLeftProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconChevronProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconCopyProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconInboxProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconEyeProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconTrashProps {
  size?: number;
  children?: React.ReactNode;
}
export interface IconEditProps {
  size?: number;
  children?: React.ReactNode;
}


// ---------------------------------------------------------------- icons

export function IconBox(props: IconBoxProps) {
  const size = props.size || 16;
  return <svg
    className="pb-icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >{props.children}</svg>;
}
export function stroke(d: string) {
  return <path d={d} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />;
}
// Kanban: three top-aligned columns drawn as 1.5-unit strokes, so the glyph
// carries the same weight as every other icon in the set (outlined bars read
// as one solid comb at 16px).
export function IconBoard(props: IconBoardProps) {
  return <IconBox {...props}>
    {stroke('M3.5 3.5v9.5')}
    {stroke('M8 3.5v5')}
    {stroke('M12.5 3.5v7.5')}
  </IconBox>;
}
export function IconDocs(props: IconDocsProps) {
  return <IconBox {...props}>
    {stroke('M4 2.5h5l3 3v8H4z')}
    {stroke('M9 2.5v3h3')}
  </IconBox>;
}
export function IconPlan(props: IconPlanProps) {
  return <IconBox {...props}>
    {stroke('M3 4h10')}
    {stroke('M3 8h7')}
    {stroke('M3 12h4')}
  </IconBox>;
}
export function IconHealth(props: IconHealthProps) { return <IconBox {...props}>{stroke('M2.5 8h2.5l1.5-3 2 6 1.5-3h3.5')}</IconBox>; }
export function IconRefresh(props: IconRefreshProps) {
  return <IconBox {...props}>
    {stroke('M13 8a5 5 0 1 1-1.6-3.7')}
    {stroke('M13 2.6V5.2h-2.6')}
  </IconBox>;
}
export function IconPlus(props: IconPlusProps) {
  return <IconBox {...props}>
    {stroke('M8 3.5v9')}
    {stroke('M3.5 8h9')}
  </IconBox>;
}
export function IconClose(props: IconCloseProps) {
  return <IconBox {...props}>
    {stroke('M4 4l8 8')}
    {stroke('M12 4l-8 8')}
  </IconBox>;
}
export function IconSearch(props: IconSearchProps) {
  return <IconBox {...props}>
    <circle cx={7} cy={7} r={3.8} stroke="currentColor" strokeWidth={1.5} />
    {stroke('M10 10l3.2 3.2')}
  </IconBox>;
}
export function IconCheck(props: IconCheckProps) { return <IconBox {...props}>{stroke('M3.2 8.4l3 3 6.4-7')}</IconBox>; }
export function IconWarning(props: IconWarningProps) {
  return <IconBox {...props}>
    {stroke('M8 2.5l6 11H2z')}
    {stroke('M8 6.5v3.2')}
    <circle cx={8} cy={11.6} r={0.85} fill="currentColor" />
  </IconBox>;
}
export function IconLock(props: IconLockProps) {
  return <IconBox {...props}>
    <rect
      x={3.5}
      y={7}
      width={9}
      height={6.5}
      rx={1.5}
      stroke="currentColor"
      strokeWidth={1.5}
    />
    {stroke('M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7')}
  </IconBox>;
}
export function IconPlay(props: IconPlayProps) { return <IconBox {...props}>{stroke('M5.5 3.5l7 4.5-7 4.5z')}</IconBox>; }
export function IconArrowLeft(props: IconArrowLeftProps) {
  return <IconBox {...props}>
    {stroke('M12.5 8H3.5')}
    {stroke('M7 4.5L3.5 8 7 11.5')}
  </IconBox>;
}
export function IconChevron(props: IconChevronProps) { return <IconBox {...props}>{stroke('M6 4l4 4-4 4')}</IconBox>; }
export function IconCopy(props: IconCopyProps) {
  return <IconBox {...props}>
    <rect
      x={5.5}
      y={5.5}
      width={7.5}
      height={8}
      rx={1.5}
      stroke="currentColor"
      strokeWidth={1.4}
    />
    <path d="M10.5 5.5V4.4A1.4 1.4 0 0 0 9.1 3H4.4A1.4 1.4 0 0 0 3 4.4v6.7a1.4 1.4 0 0 0 1.4 1.4h1.1" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
  </IconBox>;
}
export function IconInbox(props: IconInboxProps) {
  return <IconBox {...props}>
    {stroke('M2.5 8.5L4 3.5h8l1.5 5v4h-11z')}
    {stroke('M2.5 8.5h3l1 2h3l1-2h3')}
  </IconBox>;
}
export function IconEye(props: IconEyeProps) {
  return <IconBox {...props}>
    {stroke('M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8z')}
    <circle cx={8} cy={8} r={1.9} stroke="currentColor" strokeWidth={1.5} />
  </IconBox>;
}
export function IconTrash(props: IconTrashProps) {
  return <IconBox {...props}>
    {stroke('M3 4.5h10')}
    {stroke('M6.2 4.5v-1a.7.7 0 0 1 .7-.7h2.2a.7.7 0 0 1 .7.7v1')}
    {stroke('M4.4 4.5l.7 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.7-8.3')}
    {stroke('M6.6 7.2v3.6M9.4 7.2v3.6')}
  </IconBox>;
}
export function IconEdit(props: IconEditProps) {
  return <IconBox {...props}>
    {stroke('M10.8 2.9l2.3 2.3-7.2 7.2H3.6V10z')}
    {stroke('M8.9 4.8l2.3 2.3')}
  </IconBox>;
}
