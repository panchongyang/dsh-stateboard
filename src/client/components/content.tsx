// Markdown, charts and flows project parsed utils into DOM; clipboard actions stay local, with no data requests.
import React from 'react';
import type * as View from '../model/view-types.ts';
import { CHART_COLORS, chartLayout, formatChartValue, parseChartSpec, slicePath, trimLabel } from '../utils/chart.ts';
import { alignCell, docHeadings, inlineRuns, linkTarget, markdownBlocks } from '../utils/markdown.ts';
import { flowLayout, parseFlowSpec } from '../utils/flow.ts';

// Dynamic createElement registry: tag, listTag. Tags/icons are chosen from runtime data or props; static structures use JSX.

export interface ChartViewProps {
  info: string;
  text: string;
}
export interface FlowViewProps {
  text: string;
}
export interface MarkdownProps {
  body?: string;
  scope?: string;
  empty?: string;
  toc?: boolean;
  imageUrl?: (src: string) => string | null;
}





export function ChartView(props: ChartViewProps) {
  const parsed = parseChartSpec(props.info, props.text);
  if (!parsed.ok) {
    return <div className="pb-chart pb-chart--broken">
      <p className="pb-chart__error">{'图表无法解析：' + parsed.error}</p>
      <pre className="pb-md__pre">
        <code>{props.text}</code>
      </pre>
    </div>;
  }
  const spec = parsed.spec;
  const layout = chartLayout(spec);
  const summary = spec.items.map(function(item) {
    return item.label + ' ' + formatChartValue(item.value);
  }).join('，');
  const aria = (spec.title || '图表') + '：' + summary;
  const children = [];
  // chartLayout supplies Cartesian fields for these kinds and radial fields otherwise.
  // Keep the existing kind guards as the boundary for its optional projection fields.
  if (layout.kind === 'bar' || layout.kind === 'line') {
    for (let t = 0; t < layout.ticks!.length; t += 1) {
      const tick = layout.ticks![t];
      children.push(<line
        key={'grid-' + t}
        className="pb-chart__grid"
        x1={layout.padL}
        x2={layout.width - 12}
        y1={tick.y}
        y2={tick.y}
      />);
      children.push(<text key={'tick-' + t} className="pb-chart__tick" x={layout.padL! - 6} y={tick.y + 3} textAnchor="end">{formatChartValue(tick.value)}</text>);
    }
    children.push(<line
      key="axis"
      className="pb-chart__axis"
      x1={layout.padL}
      x2={layout.width - 12}
      y1={layout.zero}
      y2={layout.zero}
    />);
    if (layout.kind === 'bar') {
      for (let b = 0; b < layout.shapes!.length; b += 1) {
        const bar = layout.shapes![b];
        children.push(<rect
          key={'bar-' + b}
          className="pb-chart__bar"
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={3}
          fill={CHART_COLORS[b % CHART_COLORS.length]}
        />);
        children.push(<text key={'bv-' + b} className="pb-chart__value" x={bar.x + bar.width! / 2} y={bar.y - 4} textAnchor="middle">{formatChartValue(spec.items[b].value, spec.unit)}</text>);
      }
    } else {
      const points = layout.shapes!.map(function(point) { return point.x + ',' + point.y; }).join(' ');
      children.push(<polyline key="line" className="pb-chart__line" points={points} />);
      for (let p = 0; p < layout.shapes!.length; p += 1) {
        children.push(<circle
          key={'dot-' + p}
          className="pb-chart__dot"
          cx={layout.shapes![p].x}
          cy={layout.shapes![p].y}
          r={3.5}
          fill={CHART_COLORS[0]}
        />);
        children.push(<text key={'pv-' + p} className="pb-chart__value" x={layout.shapes![p].x} y={layout.shapes![p].y - 7} textAnchor="middle">{formatChartValue(spec.items[p].value, spec.unit)}</text>);
      }
    }
    for (let l = 0; l < layout.labels!.length; l += 1) {
      children.push(<text key={'label-' + l} className="pb-chart__label" x={layout.labels![l].x} y={layout.labels![l].y} textAnchor="middle">{layout.labels![l].text}</text>);
    }
  } else {
    for (let s = 0; s < layout.slices!.length; s += 1) {
      const slice = layout.slices![s];
      children.push(<path key={'slice-' + s} className="pb-chart__slice" d={slicePath(layout.cx!, layout.cy!, layout.radius!, layout.inner!, slice.start, slice.end)} fill={CHART_COLORS[s % CHART_COLORS.length]} />);
    }
    for (let g = 0; g < spec.items.length; g += 1) {
      const ly = 34 + g * 22;
      children.push(<rect
        key={'sw-' + g}
        x={300}
        y={ly - 9}
        width={10}
        height={10}
        rx={2}
        fill={CHART_COLORS[g % CHART_COLORS.length]}
      />);
      children.push(<text key={'lg-' + g} className="pb-chart__legend" x={316} y={ly}>{trimLabel(spec.items[g].label) + ' ' + formatChartValue(spec.items[g].value, spec.unit) + '（' + Math.round(layout.slices![g].share * 100) + '%）'}</text>);
    }
  }
  return <figure className="pb-chart">
    <figcaption className="pb-chart__title">
      {spec.title || '图表'}
      {spec.unit ? <span className="pb-chart__unit">{'（单位：' + spec.unit + '）'}</span> : null}
    </figcaption>
    <svg className="pb-chart__svg" viewBox={'0 0 ' + layout.width + ' ' + layout.height} role="img" aria-label={aria} preserveAspectRatio="xMidYMid meet">{children}</svg>
    <table className="pb-chart__sr">
      <thead>
        <tr>
          <th>{'标签'}</th>
          <th>{'数值'}</th>
        </tr>
      </thead>
      <tbody>
        {spec.items.map(function(item, index) {
          return <tr key={'row-' + index}>
            <td>{item.label}</td>
            <td>{formatChartValue(item.value, spec.unit)}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </figure>;
}
export function FlowView(props: FlowViewProps) {
  const parsed = parseFlowSpec(props.text);
  const laid = parsed.ok ? flowLayout(parsed.spec) : parsed;
  if (!laid.ok) {
    return <div className="pb-flow pb-flow--broken">
      <p className="pb-flow__error">{'流程图无法解析：' + laid.error}</p>
      <pre className="pb-md__pre">
        <code>{props.text}</code>
      </pre>
    </div>;
  }
  const layout = (laid as Extract<ReturnType<typeof flowLayout>, { ok: true }>).layout;
  const children = [<defs key="defs">
    <marker
      id="pb-flow-arrow"
      viewBox="0 0 8 8"
      refX={7}
      refY={4}
      markerWidth={7}
      markerHeight={7}
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 8 4 L 0 8 z" className="pb-flow__arrow" />
    </marker>
  </defs>];
  for (let e = 0; e < layout.edges.length; e += 1) {
    children.push(<path key={'edge-' + layout.edges[e].key} className="pb-flow__edge" d={layout.edges[e].d} markerEnd="url(#pb-flow-arrow)" />);
  }
  for (let n = 0; n < layout.nodes.length; n += 1) {
    const node = layout.nodes[n];
    children.push(<g key={'node-' + node.id} className="pb-flow__node">
      <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={6} />
      <text x={node.x + node.w / 2} y={node.y + node.h / 2 + 4} textAnchor="middle">{node.label}</text>
    </g>);
  }
  const aria = '流程图：' + layout.nodes.map(function(item) { return item.label; }).join('，')
    + '；连线 ' + layout.edges.map(function(item) { return item.from + ' 到 ' + item.to; }).join('，');
  return <figure className="pb-flow">
    <svg className="pb-flow__svg" viewBox={'0 0 ' + layout.width + ' ' + layout.height} role="img" aria-label={aria} preserveAspectRatio="xMidYMid meet">{children}</svg>
    <table className="pb-chart__sr">
      <thead>
        <tr>
          <th>{'节点'}</th>
          <th>{'连线'}</th>
        </tr>
      </thead>
      <tbody>
        {layout.nodes.map(function(item, index) {
          return <tr key={'row-' + index}>
            <td>{item.label}</td>
            <td>
              {layout.edges
                .filter(function(edge) { return edge.from === item.id; })
                .map(function(edge) { return edge.to; })
                .join('、')}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </figure>;
}

export function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  } catch (error) { /* fall through */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function DocImage(props: { url: string; alt: string; raw: string }) {
  const [failed, setFailed] = React.useState(false);
  // 解码失败、CSP 拒绝或响应损坏时退回原始 Markdown，避免留下破图。
  if (failed) return <p className="pb-md__p">{props.raw}</p>;
  return <figure className="pb-md__figure">
    <img className="pb-md__img" src={props.url} alt={props.alt} loading="lazy" onError={function() { setFailed(true); }} />
    <figcaption>{props.alt}</figcaption>
  </figure>;
}

export function Markdown(props: MarkdownProps) {
  const blocks = markdownBlocks(props.body);
  const scope = props.scope || 'md';
  if (!blocks.length) return <p className="pb-md__empty">{props.empty || '（空）'}</p>;
  const headings = props.toc ? docHeadings(blocks) : [];
  const toc = headings.length >= 2
    ? <nav className="pb-md__toc" aria-label="目录">
      {headings.map(function(item) {
        return <button key={'toc-' + item.index} type="button" className={'pb-md__toc-item pb-md__toc-item--l' + item.level} onClick={function() {
          const target = typeof document !== 'undefined' ? document.getElementById(scope + '-h-' + item.index) : null;
          if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}>{item.text}</button>;
      })}
    </nav>
    : null;
  return <div className="pb-md">
    {toc}
    {blocks.map(function(block, index) {
      const key = 'md-' + index;
      // markdownBlocks supplies each kind's fields; the type guards retain that parser contract.
      if (block.type === 'image') {
        const url = props.imageUrl?.(block.src);
        const raw = '![' + block.alt + '](' + block.src + ')';
        return url ? <DocImage key={key} url={url} alt={block.alt} raw={raw} /> : <p key={key} className="pb-md__p">{raw}</p>;
      }
      if (block.type === 'heading') {
        const tag = 'h' + Math.min(4, block.level! + 1);
        return React.createElement(tag, { key, id: scope + '-h-' + index, className: 'pb-md__h' }, inline(block.text));
      }
      if (block.type === 'code') {
        if (block.lang === 'chart') return <ChartView key={key} info={block.info!} text={block.text!} />;
        if (block.lang === 'flow') return <FlowView key={key} text={block.text!} />;
        return <div key={key} className="pb-md__codewrap">
          <div className="pb-md__codebar">
            <span className="pb-md__lang">{block.lang || 'text'}</span>
            <button type="button" className="pb-md__copy" onClick={function(event) {
              const button = event.currentTarget;
              copyToClipboard(block.text!).then(function() {
                button.textContent = '已复制';
                setTimeout(function() { button.textContent = '复制'; }, 1400);
              }, function() {
                button.textContent = '复制失败';
                setTimeout(function() { button.textContent = '复制'; }, 1400);
              });
            }}>{'复制'}</button>
          </div>
          <pre className="pb-md__pre">
            <code>{block.text}</code>
          </pre>
        </div>;
      }
      if (block.type === 'quote') {
        return <blockquote key={key} className="pb-md__quote">{inline(block.text)}</blockquote>;
      }
      if (block.type === 'table') {
        return <div key={key} className="pb-md__tablewrap">
          <table className="pb-md__table">
            <thead>
              <tr>
                {block.header!.map(function(cell, cellIndex) {
                  return <th key={'th-' + cellIndex} style={alignCell(block.align![cellIndex])}>{inline(cell)}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {block.rows!.map(function(row, rowIndex) {
                return <tr key={'row-' + rowIndex}>
                  {row.map(function(cell, cellIndex) {
                    return <td key={'td-' + cellIndex} style={alignCell(block.align![cellIndex])}>{inline(cell)}</td>;
                  })}
                </tr>;
              })}
            </tbody>
          </table>
        </div>;
      }
      if (block.type === 'hr') return <hr key={key} className="pb-md__hr" />;
      if (block.type === 'list') {
        const listTag = block.ordered ? 'ol' : 'ul';
        const listProps: { key: string; className: string; start?: number } = { key, className: 'pb-md__list' };
        if (block.ordered && Number.isInteger(block.start) && block.start !== 1) listProps.start = block.start;
        return React.createElement(listTag, listProps, block.items!.map(function(item, itemIndex) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
          if (!task) return <li key={key + '-' + itemIndex}>{inline(item)}</li>;
          return <li key={key + '-' + itemIndex} className="pb-md__task">
            <input type="checkbox" className="pb-md__check" checked={task[1] !== ' '} disabled={true} readOnly={true} />
            <span>{inline(task[2])}</span>
          </li>;
        }));
      }
      return <p key={key} className="pb-md__p">{inline(block.text)}</p>;
    })}
  </div>;
}

export function inline(text: string | undefined) {
  return inlineRuns(text).map(function(run, index) {
    const key = 'run-' + index;
    if (run.type === 'strong') return <strong key={key}>{run.text}</strong>;
    if (run.type === 'em') return <em key={key}>{run.text}</em>;
    if (run.type === 'code') return <code key={key} className="pb-md__code">{run.text}</code>;
    if (run.type === 'link') {
      const target = linkTarget(run.href);
      if (!target) return <span key={key} className="pb-md__link pb-md__link--inert" title={run.href}>{run.text}</span>;
      return <a
        key={key}
        className="pb-md__link"
        href={target.href}
        title={run.href}
        target={target.external ? '_blank' : undefined}
        rel={target.external ? 'noopener noreferrer' : undefined}
      >{run.text}</a>;
    }
    return <span key={key}>{run.text}</span>;
  });
}
