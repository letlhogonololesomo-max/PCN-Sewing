// ═══════════════════════════════════════════════════════════════════════════
// PCN SEWING — SHARED CONFIG (single source of truth for every page)
// Loaded by index.html, scan.html, downtime.html, parts-request.html and
// dashboard.html. Change a list HERE and every page picks it up — the
// dropdowns are filled from these arrays (see pcnFillSelects below), so the
// mechanic / line lists can no longer drift between pages.
// No secrets live here: the database is only reachable through /api on the
// Worker (see worker.js), and PINs are checked server-side.
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE = '/api';

const PCN = {
  siteName: 'PCN Sewing',

  // ── Push notifications ───────────────────────────────────────────────────
  // Paste the OneSignal App ID here once the app is registered (it is not a
  // secret). Leave blank to switch push notifications off. The REST API key
  // is NOT stored here — it goes in the Worker's secrets.
  oneSignalAppId: '04a4e19f-c038-417a-b5e6-18e58c2b16c7',

  // ── Shift pattern ────────────────────────────────────────────────────────
  // Mon–Thu 07:15–17:00, Fri 07:15–15:15, no weekends.
  // Every downtime calculation (shift-aware minutes, allowance, MTBF, the
  // home-screen shift card) reads from here.
  shift: {
    start:     { h: 7,  m: 15 },
    endMonThu: { h: 17, m: 0  },
    endFri:    { h: 15, m: 15 }
  },

  // ── Mechanics ────────────────────────────────────────────────────────────
  mechanics: [
    'Abongile', 'Aluvuyo', 'Amohelang', 'Asekhona', 'Ashwin', 'Clinton',
    'Jerome', 'Kano', 'Kayden', 'Kirk', 'Meketsi', 'Nico', 'Nolwazi',
    'Ntobeko', 'Sive', 'Tharollo', 'Tumelo', 'Veon'
  ],

  // ── Parts clerks ─────────────────────────────────────────────────────────
  clerks: ['Daneska'],

  // ── Sections (dashboard section filter) ─────────────────────────────────
  sections: [
    { key: 'bu1', label: 'BU1',      lines: [1, 9],   color: '#2D7D46' },
    { key: 'bu2', label: 'BU2',      lines: [10, 17], color: '#C9A84C' },
    { key: 'bu3', label: 'BU3',      lines: [18, 24], color: '#1B4F8A' },
    { key: 'wd',  label: 'Woodshed', lines: [25, 30], color: '#8B5A2B' }
  ],

  lineCount: 30,
  storage: ['Pool A', 'Pool B','Workshop'],
  rooms:   ['S/ROOM', 'T/ROOM'],

  // ── Downtime fault lists ─────────────────────────────────────────────────
  faults: [
    'Thread breaking', 'Needle breaking', 'Skipped stitches',
    'Machine not feeding', 'Machine not sewing',
    'Unusual noise / vibration', 'Machine stopped — error light',
    'Guards - Eye/Machine'
  ],
  errorCodes: [
    'Feed system fault', 'Mechanical / timing fault', 'Thread system fault',
    'Needle / hook fault', 'Setup / operator error', 'Electrical / sensor fault',
    'Other — see comments', 'Safety — Eye guard', 'Safety — Finger guard'
  ]
};

// Derived lists
PCN.lines = Array.from({ length: PCN.lineCount }, (_, i) => 'Line ' + (i + 1));
PCN.allLocations      = [...PCN.lines, ...PCN.storage, ...PCN.rooms];   // asset tracker, dashboard
PCN.downtimeLocations = [...PCN.lines, ...PCN.rooms];                   // supervisor logging
PCN.partsLocations    = [...PCN.lines, ...PCN.storage];                 // parts request
PCN.sectionLines = key => {
  const s = PCN.sections.find(x => x.key === key);
  if (!s) return null;
  const out = [];
  for (let n = s.lines[0]; n <= s.lines[1]; n++) out.push('Line ' + n);
  return out;
};

// Fill every <select data-fill="listName"> on the page, keeping its first
// (placeholder) <option>. Call once at the start of each page's script.
function pcnFillSelects() {
  document.querySelectorAll('select[data-fill]').forEach(sel => {
    const list = PCN[sel.dataset.fill];
    if (!Array.isArray(list)) return;
    const placeholder = sel.querySelector('option');
    sel.innerHTML = '';
    if (placeholder) sel.appendChild(placeholder);
    list.forEach(v => {
      const o = document.createElement('option');
      o.textContent = v;
      sel.appendChild(o);
    });
  });
}

// ── Machine types ──────────────────────────────────────────────────────────
// Shared by the Asset Tracker and Downtime Tracker "confirm machine type"
// gates. Same sewing equipment list as PMT.
const MACHINE_TYPES = [
  { code: 'BLNDST',          desc: 'BLIND STITCH MACHINE' },
  { code: 'BLT LOOP',        desc: 'BELT LOOP'},
  { code: 'BRTCK',           desc: 'BARTACKING MACHINE' },
  { code: 'BTN W/P',         desc: 'BUTTON WRAP' },
  { code: 'BUTTSM',          desc: 'BUTT SEAM' },
  { code: 'BTNHOLE',         desc: 'BUTTONHOLE MACHINE' },
  { code: 'EYELET BTNHOLE',  desc: 'EYELET BUTTON HOLE' },
  { code: 'BTNSEW CHAINST',  desc: 'BUTTON SEW-ON CHAIN STITCH' },
  { code: 'BTNSEW LOCKST',   desc: 'BUTTON SEW-ON LOCK STITCH' },
  { code: 'COVERSM',         desc: 'COVERSEAM MACHINE' },
  { code: 'BNDR',            desc: 'COVERSEAM BINDER' },
  { code: 'CYLBED',          desc: 'CYLINDERBED COVERSEAM' },
  { code: 'CYLBED with Tr',  desc: 'CYLINDERBED SPREADER & TRIMMER' },
  { code: 'ELST',            desc: 'ELASTICATOR' },
  { code: 'FLATBD',          desc: 'FLATBED COVERSEAM' },
  { code: 'AUTO-NCK',        desc: 'AUTO-NECK' },
  { code: 'DBL NDL',         desc: 'DOUBLE NEEDLE MACHINE' },
  { code: 'D/N CHAINST',     desc: 'DOUBLE NEEDLE CHAIN STITCH' },
  { code: 'D/N LOCKST',      desc: 'DOUBLE NEEDLE LOCK STITCH' },
  { code: 'EMB',             desc: 'EMBROIDERY MACHINE' },
  { code: 'FDARM',           desc: 'FEED OF THE ARM' },
  { code: 'JETPKT',          desc: 'JETPOCKET MACHINE' },
  { code: 'MULTINDL',        desc: 'MULTI NEEDLE MACHINE' },
  { code: 'NFLCK',           desc: 'NEEDLE FEED LOCKSTITCH' },
  { code: '3 THRD O/L',      desc: '3 THREAD OVERLOCK MACHINE' },
  { code: '4 THRD/MOCK O/L', desc: '4 THREAD OVERLOCK' },
  { code: '5 THRD /SFTY O/L',desc: '5 THREAD SAFETY OVERLOCK MACHINE' },
  { code: '5 THRD O/L T/B F',desc: '5THRD O/L WITH TOP AND BOTTOM FEED' },
  { code: '6THRD/MK/SFT O/L',desc: '6 THREAD MOCK SAFETY OVERLOCK MACHINE' },
  { code: 'S/N CHAINST',     desc: 'SINGLE NEEDLE CHAIN STITCH' },
  { code: 'S/N LOCKST EDGET',desc: 'SINGLE NEEDLE LOCK STITCH + EDGE TRIMMER' },
  { code: 'PLN S/N',         desc: 'PLAIN SINGLE NEEDLE LOCKSTITCH' },
  { code: 'ROUCH',           desc: 'ROUCHING MACHINE' },
  { code: 'STD',             desc: 'STUD MACHINE' },
  { code: 'ZIGZAG ST',       desc: 'ZIG ZAG STITCH MACHINE' },
];
