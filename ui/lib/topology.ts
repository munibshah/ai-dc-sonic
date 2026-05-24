// Static topology layout — kept in sync with topo/aidc.clab.yml + the FRR
// configs in configs/frr/<node>/frr.conf. If we ever add/remove a node or
// link, update here too.

export interface Link {
  /** node A name (canonically the "upper" / less-leaf-y end) */
  a: string;
  /** node B name */
  b: string;
  /** IP on A's end of the /31 (no mask) */
  aIp: string;
  /** IP on B's end of the /31 */
  bIp: string;
  /** /31 subnet — e.g. "10.1.1.0/31" */
  subnet: string;
}

export const LINKS: Link[] = [
  // --- spine <-> leaf (8) ---
  { a: "spine1", b: "leaf1", aIp: "10.1.1.0", bIp: "10.1.1.1", subnet: "10.1.1.0/31" },
  { a: "spine1", b: "leaf2", aIp: "10.1.1.2", bIp: "10.1.1.3", subnet: "10.1.1.2/31" },
  { a: "spine1", b: "leaf3", aIp: "10.1.1.4", bIp: "10.1.1.5", subnet: "10.1.1.4/31" },
  { a: "spine1", b: "leaf4", aIp: "10.1.1.6", bIp: "10.1.1.7", subnet: "10.1.1.6/31" },
  { a: "spine2", b: "leaf1", aIp: "10.1.2.0", bIp: "10.1.2.1", subnet: "10.1.2.0/31" },
  { a: "spine2", b: "leaf2", aIp: "10.1.2.2", bIp: "10.1.2.3", subnet: "10.1.2.2/31" },
  { a: "spine2", b: "leaf3", aIp: "10.1.2.4", bIp: "10.1.2.5", subnet: "10.1.2.4/31" },
  { a: "spine2", b: "leaf4", aIp: "10.1.2.6", bIp: "10.1.2.7", subnet: "10.1.2.6/31" },
  // --- leaf <-> worker (8) ---
  { a: "leaf1", b: "gpu1", aIp: "10.2.1.0", bIp: "10.2.1.1", subnet: "10.2.1.0/31" },
  { a: "leaf1", b: "gpu2", aIp: "10.2.1.2", bIp: "10.2.1.3", subnet: "10.2.1.2/31" },
  { a: "leaf2", b: "gpu3", aIp: "10.2.2.0", bIp: "10.2.2.1", subnet: "10.2.2.0/31" },
  { a: "leaf2", b: "gpu4", aIp: "10.2.2.2", bIp: "10.2.2.3", subnet: "10.2.2.2/31" },
  { a: "leaf3", b: "gpu5", aIp: "10.2.3.0", bIp: "10.2.3.1", subnet: "10.2.3.0/31" },
  { a: "leaf3", b: "gpu6", aIp: "10.2.3.2", bIp: "10.2.3.3", subnet: "10.2.3.2/31" },
  { a: "leaf4", b: "gpu7", aIp: "10.2.4.0", bIp: "10.2.4.1", subnet: "10.2.4.0/31" },
  { a: "leaf4", b: "gpu8", aIp: "10.2.4.2", bIp: "10.2.4.3", subnet: "10.2.4.2/31" },
];

// Node centre positions inside the SVG viewBox (0 0 1200 620).
// Three rows: spines top, leaves middle, workers bottom.
// Workers are paired under their leaf (centre of pair = leaf x).
export const POS: Record<string, [number, number]> = {
  spine1: [400, 80],
  spine2: [800, 80],

  leaf1: [150, 310],
  leaf2: [450, 310],
  leaf3: [750, 310],
  leaf4: [1050, 310],

  gpu1: [75, 540],
  gpu2: [225, 540],
  gpu3: [375, 540],
  gpu4: [525, 540],
  gpu5: [675, 540],
  gpu6: [825, 540],
  gpu7: [975, 540],
  gpu8: [1125, 540],
};

export const VIEW_W = 1200;
export const VIEW_H = 620;
export const NODE_W = 110;
export const NODE_H = 56;
