/** Fixture: classic JSX component, React stays external. */
import React from 'react';
import { formatCount } from './format.ts';

export interface CardProps {
  count: number;
}

export function Card(props: CardProps) {
  return <div className="fixture-card">{formatCount(props.count)}</div>;
}
