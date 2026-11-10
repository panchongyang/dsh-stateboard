/**
 * ```flow — a deliberately small flowchart DSL.
 *
 * Grammar (one statement per line, # starts a comment):
 *   id[标签]      declare a node (label optional, defaults to the id)
 *   a -> b        declare a directed edge between declared nodes
 *
 * Anything beyond that (subgraphs, styling, sequence diagrams, hand-routed
 * edges) is out of scope on purpose: the layout is longest-path layering with
 * declaration order inside a layer.
 */

export interface FlowNode { id: string; label: string; order: number }
export interface FlowEdge { from: string; to: string }
export interface FlowSpec { nodes: FlowNode[]; edges: FlowEdge[] }
export interface FlowBox { id: string; label: string; layer: number; x: number; y: number; w: number; h: number }
export interface FlowPath extends FlowEdge { key: string; d: string }
export type FlowResult = { ok: true; spec: FlowSpec; error?: never } | { ok: false; error: string; spec?: never };
export interface FlowGeometry { width: number; height: number; nodes: FlowBox[]; edges: FlowPath[]; layers: number }
export type FlowLayoutResult = { ok: true; layout: FlowGeometry; error?: never } | { ok: false; error: string; layout?: never };

export const FLOW_NODE_H = 34;
export const FLOW_GAP_X = 48;
export const FLOW_GAP_Y = 16;
export const FLOW_PAD = 14;

/** Rough text width so a node box never clips its label. */
export function flowTextWidth(text: unknown): number {
  const body = String(text == null ? '' : text);
  let width = 0;
  for (let i = 0; i < body.length; i += 1) {
    width += /[\u2e80-\u9fff\uff00-\uffef]/.test(body.charAt(i)) ? 13.5 : 7.4;
  }
  return width;
}

/** Pure: parse the DSL into {ok, spec:{nodes, edges}} or {ok:false, error}. */
export function parseFlowSpec(text: unknown): FlowResult {
  const lines = String(text == null ? '' : text).split('\n');
  const nodes = [];
  const byId: Record<string, FlowNode> = {};
  const edges = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.charAt(0) === '#') continue;
    const edgeMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*->\s*([A-Za-z_][A-Za-z0-9_-]*)$/.exec(line);
    if (edgeMatch) {
      if (edgeMatch[1] === edgeMatch[2]) return { ok: false, error: '第 ' + (i + 1) + ' 行是自环：' + edgeMatch[1] + ' -> ' + edgeMatch[2] };
      edges.push({ from: edgeMatch[1], to: edgeMatch[2] });
      continue;
    }
    const decl = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[\s*([^\]]*)\s*\])?$/.exec(line);
    if (!decl) return { ok: false, error: '第 ' + (i + 1) + ' 行无法解析：应写成「id[标签]」或「a -> b」' };
    const id = decl[1];
    if (byId[id]) return { ok: false, error: '节点「' + id + '」在第 ' + (i + 1) + ' 行重复声明' };
    const label = (decl[2] || '').trim() || id;
    const node: FlowNode = { id, label, order: nodes.length };
    byId[id] = node;
    nodes.push(node);
  }
  if (nodes.length === 0) return { ok: false, error: '没有节点' };
  if (nodes.length > 40) return { ok: false, error: '节点超过 40 个，请拆成多张图' };
  const unknown = [];
  for (let e = 0; e < edges.length; e += 1) {
    if (!byId[edges[e].from] && unknown.indexOf(edges[e].from) < 0) unknown.push(edges[e].from);
    if (!byId[edges[e].to] && unknown.indexOf(edges[e].to) < 0) unknown.push(edges[e].to);
  }
  if (unknown.length) return { ok: false, error: '边引用了未声明的节点：' + unknown.join('、') };
  const isolated = [];
  for (let n = 0; n < nodes.length; n += 1) {
    let touched = false;
    for (let m = 0; m < edges.length; m += 1) {
      if (edges[m].from === nodes[n].id || edges[m].to === nodes[n].id) { touched = true; break; }
    }
    if (!touched) isolated.push(nodes[n].id);
  }
  if (isolated.length) return { ok: false, error: '孤立节点（没有任何连线）：' + isolated.join('、') };
  const seen: Record<string, boolean> = {};
  const unique = [];
  for (let u = 0; u < edges.length; u += 1) {
    const key = edges[u].from + '->' + edges[u].to;
    if (seen[key]) continue;
    seen[key] = true;
    unique.push(edges[u]);
  }
  return { ok: true, spec: { nodes, edges: unique } };
}

/** Pure: longest-path layering; same-layer order follows declaration order. */
export function flowLayout(spec: FlowSpec): FlowLayoutResult {
  const nodes = (spec && spec.nodes) || [];
  const edges = (spec && spec.edges) || [];
  const indegree: Record<string, number> = {};
  const outgoing: Record<string, string[]> = {};
  for (let i = 0; i < nodes.length; i += 1) {
    indegree[nodes[i].id] = 0;
    outgoing[nodes[i].id] = [];
  }
  for (let e = 0; e < edges.length; e += 1) {
    indegree[edges[e].to] += 1;
    outgoing[edges[e].from].push(edges[e].to);
  }
  const queue = [];
  for (let q = 0; q < nodes.length; q += 1) if (indegree[nodes[q].id] === 0) queue.push(nodes[q].id);
  const order = [];
  while (queue.length) {
    const id: string = queue.shift()!; // The loop guard guarantees a queued node.
    order.push(id);
    const nexts: string[] = outgoing[id];
    for (let k = 0; k < nexts.length; k += 1) {
      indegree[nexts[k]] -= 1;
      if (indegree[nexts[k]] === 0) queue.push(nexts[k]);
    }
  }
  if (order.length !== nodes.length) {
    const cycle = [];
    for (let c = 0; c < nodes.length; c += 1) if (indegree[nodes[c].id] > 0) cycle.push(nodes[c].id);
    return { ok: false, error: '存在环：' + cycle.join('、') };
  }
  const layer = layerOf(nodes, order, edges);
  const columns: FlowNode[][] = [];
  for (let n = 0; n < nodes.length; n += 1) {
    const at = layer[nodes[n].id];
    while (columns.length <= at) columns.push([]);
    columns[at].push(nodes[n]);
  }
  const widthOf: Record<string, number> = {};
  for (let w = 0; w < nodes.length; w += 1) widthOf[nodes[w].id] = Math.max(72, Math.round(flowTextWidth(nodes[w].label)) + 28);
  const placed: Record<string, FlowBox> = {};
  const columnWidths = [];
  let maxRows = 0;
  for (let col = 0; col < columns.length; col += 1) {
    let widest = 0;
    for (let cw = 0; cw < columns[col].length; cw += 1) widest = Math.max(widest, widthOf[columns[col][cw].id]);
    columnWidths.push(widest);
    maxRows = Math.max(maxRows, columns[col].length);
  }
  const contentHeight = maxRows * FLOW_NODE_H + Math.max(0, maxRows - 1) * FLOW_GAP_Y;
  let cursorX = FLOW_PAD;
  for (let column = 0; column < columns.length; column += 1) {
    const stackHeight = columns[column].length * FLOW_NODE_H + Math.max(0, columns[column].length - 1) * FLOW_GAP_Y;
    let cursorY = FLOW_PAD + (contentHeight - stackHeight) / 2;
    for (let p = 0; p < columns[column].length; p += 1) {
      const current = columns[column][p];
      placed[current.id] = {
        id: current.id, label: current.label, layer: column,
        x: cursorX, y: cursorY, w: widthOf[current.id], h: FLOW_NODE_H,
      };
      cursorY += FLOW_NODE_H + FLOW_GAP_Y;
    }
    cursorX += columnWidths[column] + FLOW_GAP_X;
  }
  const edgePaths = edgePathsFor(edges, placed);
  const boxes = [];
  for (let b = 0; b < nodes.length; b += 1) boxes.push(placed[nodes[b].id]);
  return {
    ok: true,
    layout: {
      width: cursorX - FLOW_GAP_X + FLOW_PAD,
      height: contentHeight + FLOW_PAD * 2,
      nodes: boxes,
      edges: edgePaths,
      layers: columns.length,
    },
  };
}

/** Longest-path layering: each edge pushes its target one layer past its source. */
function layerOf(nodes: FlowNode[], order: string[], edges: FlowEdge[]): Record<string, number> {
  const layer: Record<string, number> = {};
  for (let l = 0; l < nodes.length; l += 1) layer[nodes[l].id] = 0;
  for (let o = 0; o < order.length; o += 1) {
    const from = order[o];
    for (let x = 0; x < edges.length; x += 1) {
      if (edges[x].from === from && layer[edges[x].to] < layer[from] + 1) layer[edges[x].to] = layer[from] + 1;
    }
  }
  return layer;
}

/** Orthogonal connectors: out of the source's right edge, into the target's left. */
function edgePathsFor(edges: FlowEdge[], placed: Record<string, FlowBox>): FlowPath[] {
  const paths = [];
  for (let edge = 0; edge < edges.length; edge += 1) {
    const source = placed[edges[edge].from];
    const target = placed[edges[edge].to];
    const x1 = source.x + source.w;
    const y1 = source.y + source.h / 2;
    const x2 = target.x;
    const y2 = target.y + target.h / 2;
    const middle = Math.round((x1 + x2) / 2);
    paths.push({
      key: edges[edge].from + '->' + edges[edge].to,
      from: edges[edge].from,
      to: edges[edge].to,
      d: 'M ' + x1 + ' ' + y1 + ' H ' + middle + ' V ' + y2 + ' H ' + x2,
    });
  }
  return paths;
}
