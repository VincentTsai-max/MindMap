/* =====================================================================
 * mindmap.js — 心智圖編輯器前端核心
 * 靜態版：搭配 index.html（畫面）與 Google Apps Script 後端（Code.gs，資料存 Google Sheet + Drive）
 *
 * 設計重點：
 *  - 節點以扁平表存於 state.nodes（id → node），版面每次全量重算
 *  - 中心主題置中、第一層分支左右平衡（side: 'R' / 'L'）
 *  - 深度 0/1 為填色圓角框、深度 2+ 為文字加底線（貼近 XMind 視覺）
 *  - 鍵盤操作：Tab 子主題、Enter 同層、F2/空白編輯、方向鍵移動選取
 *  - 拖曳節點可搬移：放到節點中央成為子主題、上/下緣插入為同層
 *  - 復原/重做以整份 JSON 快照實作，簡單而可靠
 * ===================================================================== */
(function () {
    'use strict';

    /* ---------------- 常數與樣式 ---------------- */
    var FONT_FAMILY = '"Segoe UI","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
    var PALETTE = ['#E5534B', '#EE8435', '#D6A014', '#7CA82B', '#22A198', '#3D8AF7', '#7C64E8', '#D3569B'];
    var ROOT_FILL = '#34495E';
    var SEL_COLOR = '#4C9AFF';

    /* ---------------- P5：主題 ---------------- */
    var THEMES = {
        classic: {
            canvas: '', ink: '#333A45', inkOnLight: '#333A45',
            rootFill: '#34495E',
            palette: ['#E5534B', '#EE8435', '#D6A014', '#7CA82B', '#22A198', '#3D8AF7', '#7C64E8', '#D3569B'],
            plainFill: '#FFFFFF', boxedFill: '#FFFFFF',
            tableLine: '#B9C2CF', tableHead: 'rgba(0,0,0,0.06)'
        },
        dark: {
            canvas: '#1F2430', ink: '#E6E9F2', inkOnLight: '#20242E',
            rootFill: '#E8EAF0',
            palette: ['#FF7A70', '#FFA155', '#EDBE3A', '#9CCB4E', '#3FC4BA', '#6FA8FF', '#9E8CFF', '#F07BC0'],
            plainFill: '#2A3140', boxedFill: '#2A3140',
            tableLine: '#55607A', tableHead: 'rgba(255,255,255,0.08)'
        }
    };
    function themeOf() { return THEMES[state.mapTheme] || THEMES.classic; }

    /* 亮度公式：0.299r+0.587g+0.114b < 140 視為深色 → 配白字 */
    function isDarkColor(hex) {
        var m = /^#?([0-9a-fA-F]{6})$/.exec(('' + hex).trim());
        if (!m) return true;
        var v = parseInt(m[1], 16);
        var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }

    function applyTheme() {
        var th = themeOf();
        if (els.stage) els.stage.style.background = th.canvas || '';
    }

    /* 七種節點形狀（P5）：回傳可直接 append 的 SVG 元素 */
    function shapeEl(shape, x, y, w, h, r, attrs) {
        function withAttrs(base) {
            for (var k in attrs) {
                if (attrs[k] == null) continue;
                base[k] = attrs[k];
            }
            return base;
        }
        switch (shape) {
            case 'rect':
                return mk('rect', withAttrs({ x: r2(x), y: r2(y), width: r2(w), height: r2(h), rx: 2 }));
            case 'ellipse':
                return mk('ellipse', withAttrs({ cx: r2(x + w / 2), cy: r2(y + h / 2), rx: r2(w / 2), ry: r2(h / 2) }));
            case 'diamond':
                return mk('path', withAttrs({
                    d: 'M ' + r2(x + w / 2) + ' ' + r2(y) +
                       ' L ' + r2(x + w) + ' ' + r2(y + h / 2) +
                       ' L ' + r2(x + w / 2) + ' ' + r2(y + h) +
                       ' L ' + r2(x) + ' ' + r2(y + h / 2) + ' Z'
                }));
            case 'hexagon': {
                var inx = Math.min(14, w / 4);
                return mk('path', withAttrs({
                    d: 'M ' + r2(x + inx) + ' ' + r2(y) +
                       ' L ' + r2(x + w - inx) + ' ' + r2(y) +
                       ' L ' + r2(x + w) + ' ' + r2(y + h / 2) +
                       ' L ' + r2(x + w - inx) + ' ' + r2(y + h) +
                       ' L ' + r2(x + inx) + ' ' + r2(y + h) +
                       ' L ' + r2(x) + ' ' + r2(y + h / 2) + ' Z'
                }));
            }
            default: /* rounded */
                return mk('rect', withAttrs({ x: r2(x), y: r2(y), width: r2(w), height: r2(h), rx: r }));
        }
    }
    var BG_COLOR = '#F5F6F7';
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var AUTOSAVE_MS = 15000;

    /* 樣式：以 depth 為主、structure 為輔——org/tree 直排結構下 depth≥2 改「小方框」款（底線款直排很醜） */
    function styleFor(depth, structure) {
        if (depth === 0) return { fs: 18, fw: 700, padX: 24, padY: 13, lineH: 26, radius: 10, minW: 96, maxW: 260 };
        if (depth === 1) return { fs: 15, fw: 600, padX: 16, padY: 9, lineH: 22, radius: 8, minW: 56, maxW: 240 };
        if (structure === 'org-down' || structure === 'tree-right') {
            return { fs: 13, fw: 400, padX: 10, padY: 5, lineH: 19, radius: 6, minW: 40, maxW: 220, boxed: true };
        }
        return { fs: 13, fw: 400, padX: 8, padY: 4, lineH: 19, radius: 6, minW: 24, maxW: 220 };
    }
    function hGap(childDepth) { return childDepth === 1 ? 64 : (childDepth === 2 ? 44 : 36); }
    function vGap(childDepth) { return childDepth === 1 ? 26 : 12; }
    function hGapOrg(childDepth) { return childDepth === 1 ? 28 : 20; }   /* org-down 兄弟水平間距 */
    function vGapOrg(childDepth) { return childDepth === 1 ? 44 : 32; }   /* org-down 父子垂直層距 */
    var TREE_INDENT = 28, TREE_VGAP = 10;                                  /* tree-right 縮排／行距 */
    function linkWidth(depth) { return depth <= 1 ? 3.2 : (depth === 2 ? 2.4 : 1.8); }

    /* ---------------- 全域狀態 ---------------- */
    var state = {
        mapId: null,
        sheetId: null,        // 目前頁面（P0.5 分頁）
        sheets: [],           // [{sheetId,title,sortOrder}]
        title: '',
        nodes: {},            // id → {id,parentId,text,sortOrder,collapsed,side,color,type,posX,posY,structure,props}
        centralId: null,      // 中心主題（v2：另有多個 floating 根）
        relations: [],        // {relId,fromId,toId,label,props(字串)}
        boundaries: [],       // {boundaryId,parentId,fromChildId,toChildId,label,props(字串)}
        summaries: [],        // {summaryId,parentId,fromChildId,toChildId,topicId}
        mapStructure: 'mindmap',
        mapTheme: 'classic',
        mapProps: null,       // 地圖層級 props（JSON 字串原樣進出）
        selectedId: null,
        selectedIds: [],      // 多選（P4 起有 UI；恆包含 selectedId）
        selectedRelId: null,  // 選取中的關聯線（與節點選取互斥）
        selectedBoundaryId: null, // 選取中的外框（P4）
        linking: null,        // 連線模式 {fromId}（P3）
        editingId: null,
        editingRelId: null,   // 正在編輯標籤的關聯線
        editingBoundaryId: null,  // 正在編輯標籤的外框
        linkFor: null,        // 超連結視窗目前對象（P5）
        noteFor: null,        // 備註視窗目前對象（P5）
        picking: null,        // 主題連結點選模式 {forId}（P5）
        pitch: null,          // 演示模式狀態（P7）：{slides,idx,savedView,expanded,raf}
        ai: null,              // AI 生成進行狀態（P8）：{mode,forId,busy}
        scale: 1, panX: 0, panY: 0,
        dirty: false, saving: false, lastSaved: null,
        undoStack: [], redoStack: [],
        autoSave: true,
        drag: null,           // {id, startX, startY, active, target}
        pan: null             // {startX, startY, panX0, panY0}
    };

    var els = {};
    function $(id) { return document.getElementById(id); }

    /* ---------------- 文字量測（canvas；jsdom 等環境改用估算） ---------------- */
    var _mctx = null;
    function measureInit() {
        try {
            var c = document.createElement('canvas');
            _mctx = (c && c.getContext) ? c.getContext('2d') : null;
            if (_mctx && typeof _mctx.measureText !== 'function') _mctx = null;
        } catch (e) { _mctx = null; }
    }
    function textWidth(s, font, fs) {
        if (_mctx) { _mctx.font = font; return _mctx.measureText(s).width; }
        var w = 0;
        for (var i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 0x2E7F) ? fs : fs * 0.55;
        return w;
    }
    /* 中日韓逐字換行、英數以詞為單位換行 */
    function wrapText(text, font, fs, maxW) {
        var out = [];
        var paras = String(text == null ? '' : text).split('\n');
        for (var p = 0; p < paras.length; p++) {
            var raw = paras[p];
            var tokens = raw.match(/[\u2E80-\u9FFF\u3000-\u303F\uF900-\uFAFF\uFF00-\uFFEF]|[^\u2E80-\u9FFF\u3000-\u303F\uF900-\uFAFF\uFF00-\uFFEF\s]+\s*|\s+/g) || [''];
            var line = '';
            for (var i = 0; i < tokens.length; i++) {
                var t = tokens[i];
                if (line && textWidth(line + t, font, fs) > maxW) {
                    out.push(line.replace(/\s+$/, ''));
                    line = t.replace(/^\s+/, '');
                    while (line.length > 1 && textWidth(line, font, fs) > maxW) {
                        var cut = line.length - 1;
                        while (cut > 1 && textWidth(line.slice(0, cut), font, fs) > maxW) cut--;
                        out.push(line.slice(0, cut));
                        line = line.slice(cut);
                    }
                } else {
                    line += t;
                }
            }
            out.push(line.replace(/\s+$/, ''));
        }
        if (!out.length) out.push('');
        return out;
    }

    /* ---------------- 樹狀結構工具 ---------------- */
    function node(id) { return state.nodes[id] || null; }

    function sideOf(n) { return n && n.side === 'L' ? 'L' : 'R'; }

    /* props：資料庫/傳輸為 JSON「字串」，記憶體為物件（§2 決策二） */
    function safeParseProps(s) {
        if (!s || typeof s !== 'string') return null;
        try {
            var o = JSON.parse(s);
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }
    function propsToStr(o) {
        if (!o) return null;
        var has = false;
        for (var k in o) { has = true; break; }
        if (!has) return null;
        try { return JSON.stringify(o); } catch (e) { return null; }
    }

    function blankNode(id, parentId, text, type) {
        return {
            id: id, parentId: parentId || null, text: text || '',
            sortOrder: 0, collapsed: false, side: null, color: null,
            type: type || 'topic', posX: null, posY: null, structure: null, props: null
        };
    }

    /* 所有浮動主題的根（type='floating' 且無父） */
    function floatingRoots() {
        var out = [];
        for (var k in state.nodes) {
            var n = state.nodes[k];
            if (n.type === 'floating' && !n.parentId) out.push(n);
        }
        return sortSibs(out);
    }

    /* 節點「子樹」的有效結構（§2 決策四）：
       覆寫 > 根預設（central=地圖結構、floating=logic-right）> 繼承父；
       mindmap 父 → 依本節點 side 展開為 logic-left / logic-right */
    function structureOf(n) {
        if (!n) return state.mapStructure || 'mindmap';
        if (n.structure) return n.structure;
        if (!n.parentId) {
            if (n.type === 'floating') return 'logic-right';
            return state.mapStructure || 'mindmap';
        }
        var ps = structureOf(node(n.parentId));
        if (ps === 'mindmap') return sideOf(n) === 'L' ? 'logic-left' : 'logic-right';
        return ps;
    }

    /* 刪除節點後，同步修理引用：關聯直接丟棄；外框/概要先嘗試收縮區間，收不了才丟棄 */
    function pruneRefs(doomedMap) {
        var i;
        for (i = state.relations.length - 1; i >= 0; i--) {
            var r = state.relations[i];
            if (doomedMap[r.fromId] || doomedMap[r.toId]) state.relations.splice(i, 1);
        }
        for (i = state.boundaries.length - 1; i >= 0; i--) {
            var b = state.boundaries[i];
            var bms = b.memberIds || [], bKeep = [];
            for (var bmI = 0; bmI < bms.length; bmI++) if (!doomedMap[bms[bmI]]) bKeep.push(bms[bmI]);
            if (!bKeep.length) { state.boundaries.splice(i, 1); continue; }
            b.memberIds = bKeep;
        }
        for (i = state.summaries.length - 1; i >= 0; i--) {
            var s = state.summaries[i];
            if (doomedMap[s.parentId] || doomedMap[s.topicId]) { state.summaries.splice(i, 1); continue; }
            if (doomedMap[s.fromChildId] || doomedMap[s.toChildId]) {
                var fs = fixRange(s.parentId,
                    doomedMap[s.fromChildId] ? null : s.fromChildId,
                    doomedMap[s.toChildId] ? null : s.toChildId);
                if (fs) { s.fromChildId = fs.from; s.toChildId = fs.to; }
                else state.summaries.splice(i, 1);
            }
        }
    }

    /* 區間所屬的兄弟序列：中心主題（mindmap）之下只取同側 */
    function rangeSibs(parentId, refChildId) {
        var sibs = childrenOf(parentId);
        var p = node(parentId), ref = node(refChildId);
        if (p && ref && parentId === state.centralId && structureOf(p) === 'mindmap') {
            var sd = sideOf(ref);
            var out = [];
            for (var i = 0; i < sibs.length; i++) if (sideOf(sibs[i]) === sd) out.push(sibs[i]);
            return out;
        }
        return sibs;
    }

    /* 修復規則 7：外框/概要的兄弟區間收縮（端點缺一補一、缺二丟棄、顛倒交換） */
    function fixRange(parentId, fromId, toId) {
        if (!parentId || !state.nodes[parentId]) return null;
        var sibs = childrenOf(parentId);
        var iF = -1, iT = -1, i;
        for (i = 0; i < sibs.length; i++) {
            if (sibs[i].id === fromId) iF = i;
            if (sibs[i].id === toId) iT = i;
        }
        if (iF < 0 && iT < 0) return null;
        if (iF < 0) iF = iT;
        if (iT < 0) iT = iF;
        if (iF > iT) { var t = iF; iF = iT; iT = t; }
        return { from: sibs[iF].id, to: sibs[iT].id };
    }

    function sortSibs(arr) {
        arr.sort(function (a, b) {
            return (a.sortOrder - b.sortOrder) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
        });
        return arr;
    }

    function buildChildIndex(includeSpecial) {
        var idx = {};
        for (var k in state.nodes) {
            var n = state.nodes[k];
            if (!includeSpecial && (n.type === 'callout' || n.type === 'summary')) continue;
            var p = n.parentId || '';
            (idx[p] = idx[p] || []).push(n);
        }
        for (var key in idx) sortSibs(idx[key]);
        return idx;
    }

    function childrenOf(id, includeSpecial) {
        var out = [];
        for (var k in state.nodes) {
            var n = state.nodes[k];
            if (n.parentId !== id) continue;
            if (!includeSpecial && (n.type === 'callout' || n.type === 'summary')) continue;
            out.push(n);
        }
        return sortSibs(out);
    }

    function isDescendant(ancId, id) {
        var cur = node(id);
        var guard = 0;
        while (cur && cur.parentId && guard++ < 10000) {
            if (cur.parentId === ancId) return true;
            cur = node(cur.parentId);
        }
        return false;
    }

    function countDesc(id) {
        var cnt = 0;
        var kids = childrenOf(id);
        for (var i = 0; i < kids.length; i++) cnt += 1 + countDesc(kids[i].id);
        return cnt;
    }

    /* 分支顏色：自己或最近祖先的自訂色優先，否則依第一層分支序取調色盤 */
    function effColor(n) {
        var cur = n, guard = 0, depth1 = null;
        while (cur && guard++ < 10000) {
            if (cur.color) return cur.color;
            if (cur.parentId === state.centralId) depth1 = cur;
            if (!cur.parentId) break;
            cur = node(cur.parentId);
        }
        var th = themeOf();
        /* 浮動樹：依浮動序輪流取色 */
        if (!depth1 && cur && cur.type === 'floating') {
            var fls = floatingRoots();
            for (var fi = 0; fi < fls.length; fi++) {
                if (fls[fi].id === cur.id) return th.palette[fi % th.palette.length];
            }
        }
        if (!depth1) return th.rootFill;
        var mains = childrenOf(state.centralId);
        var i = 0;
        for (var j = 0; j < mains.length; j++) if (mains[j].id === depth1.id) { i = j; break; }
        return th.palette[i % th.palette.length];
    }

    /* ---------------- 版面配置 ---------------- */
    function metricsFor(n, depth) {
        var base = styleFor(depth, structureOf(n));
        var pr = n.props || {};

        /* 有效字級（props.font 覆寫） */
        var st = {
            fs: base.fs, fw: base.fw, padX: base.padX, padY: base.padY,
            lineH: base.lineH, radius: base.radius, minW: base.minW, maxW: base.maxW,
            boxed: !!base.boxed
        };
        if (pr.font) {
            if (pr.font.size) {
                st.fs = Math.max(9, Math.min(48, pr.font.size | 0));
                st.lineH = Math.max(14, Math.round(st.fs * 1.45));
            }
            if (pr.font.bold != null) st.fw = pr.font.bold ? 700 : 400;
        }
        if (pr.shape === 'diamond') st.padX = base.padX + 10;   /* 菱形尖角需要更多內距 */
        n._st = st;

        var font = st.fw + ' ' + st.fs + 'px ' + FONT_FAMILY;

        /* 標記（emoji 前綴）與右側小圖示（🔗/📝）寬度 */
        var markers = Array.isArray(pr.markers)
            ? pr.markers.filter(function (m) { return typeof m === 'string' && m; })
            : [];
        var markersW = markers.length ? markers.length * (st.fs + 4) + 4 : 0;
        var iconList = [];
        if (pr.link && pr.link.value) iconList.push('link');
        if (pr.note) iconList.push('note');
        var iconsW = iconList.length ? iconList.length * (st.fs + 4) + 2 : 0;

        /* 固定寬度：以 fixedWidth 反推內文換行寬 */
        var fixed = (pr.widthMode === 'fixed' && pr.fixedWidth > 0)
            ? Math.max(60, pr.fixedWidth | 0) : 0;
        var wrapW = fixed ? Math.max(24, fixed - st.padX * 2 - markersW - iconsW) : st.maxW;

        var lines = wrapText(n.text || '', font, st.fs, wrapW);
        var wMax = 0;
        for (var i = 0; i < lines.length; i++) {
            var w0 = textWidth(lines[i], font, st.fs);
            if (w0 > wMax) wMax = w0;
        }
        n._lines = lines;

        var textH = lines.length * st.lineH;
        var innerW = Math.ceil(wMax) + markersW + iconsW;
        n.w = fixed ? fixed : Math.max(st.minW, innerW + st.padX * 2);

        n.h = st.padY * 2 + textH;

        /* 圖片：置於文字上方，撐開寬度／預留高度 */
        var img = pr.image;
        if (img && img.fileId && img.w && img.h) {
            n.w = Math.max(n.w, img.w + st.padX * 2);
            n.h += img.h + 8;
        }

        /* 附檔清單：文字（與表格/圖片）下方逐行小標籤 */
        var atts = Array.isArray(pr.attachments) ? pr.attachments : [];
        var attW = 0, attH = 0;
        if (atts.length) {
            var af = '400 11.5px ' + FONT_FAMILY;
            for (var ai = 0; ai < atts.length; ai++) {
                var aw = textWidth('📎 ' + (atts[ai].fileName || ''), af, 11.5) + 10;
                if (aw > attW) attW = aw;
            }
            attH = atts.length * 18 + 4;
            n.w = Math.max(n.w, attW + st.padX * 2);
            n.h += attH;
        }

        /* 內部區域模型（座標相對節點左上角） */
        var imgH = (img && img.fileId && img.w && img.h) ? (img.h + 8) : 0;
        var textY = st.padY + imgH;
        n._regions = {
            aligned: !!(markersW || iconsW),
            text: { x: st.padX + markersW, y: textY, w: n.w - st.padX * 2 - markersW - iconsW, h: textH }
        };
        if (imgH) {
            n._regions.image = {
                x: st.padX + Math.max(0, ((n.w - st.padX * 2) - img.w) / 2),
                y: st.padY, w: img.w, h: img.h, fileId: img.fileId
            };
        }
        if (markersW) n._regions.markers = { x: st.padX, y: textY, w: markersW, h: st.lineH, list: markers };
        if (iconsW) n._regions.icons = { x: n.w - st.padX - iconsW, y: textY, w: iconsW, h: st.lineH, list: iconList };
        var afterTextY = textY + textH;
        if (atts.length) {
            n._regions.attachments = {
                x: st.padX, y: afterTextY + 6, w: attW, h: attH, list: atts
            };
        }
    }

    /* ---------------- 佈局（v2 契約：外接框 _bw/_bh ＋ 根錨點 _ax/_ay） ----------------
       measure(n,depth,idx)：由下而上算出子樹外接框大小與根節點錨點（不動座標）
       place(n,bx,by,depth,idx)：給定外接框「左上角」(bx,by)，設定 n.cx/cy 並遞迴擺放子樹
       規則：節點本身由「父的策略」擺位；節點的「子樹」用自己的策略（structureOf）。
       P1 會在各策略補上 anchorOut/anchorIn/linkPath/nav；P0 先共用原有貝茲 drawLink。 */

    var STRUCTURES = {};

    function visibleKids(n, idx) {
        if (n.collapsed) return [];
        return idx[n.id] || [];
    }

    function measureNode(n, depth, idx) {
        (STRUCTURES[structureOf(n)] || STRUCTURES['logic-right']).measure(n, depth, idx);
    }
    function placeNode(n, bx, by, depth, idx) {
        (STRUCTURES[structureOf(n)] || STRUCTURES['logic-right']).place(n, bx, by, depth, idx);
    }

    /* ---- P4：外框留白＋概要空間保留 ----
       _bPads[childId] = {before, after}：直疊時在該子前/後多留的空隙。
       外框＝固定 12（取 max）；概要＝墊高 diff/2（累加，於父 measure 時動態寫入）。 */
    var _bPads = {};
    function padOf(id, k) {
        var p = _bPads[id];
        return (p && p[k]) ? p[k] : 0;
    }
    function padMax(id, k, v) {
        var p = _bPads[id] || (_bPads[id] = {});
        if (!p[k] || p[k] < v) p[k] = v;
    }
    function padAdd(id, k, v) {
        var p = _bPads[id] || (_bPads[id] = {});
        p[k] = (p[k] || 0) + v;
    }
    function buildBoundaryPads() {
        _bPads = {};
        for (var i = 0; i < state.boundaries.length; i++) {
            var cls = boundaryClusters(state.boundaries[i]);
            for (var c = 0; c < cls.length; c++) {
                var ids = cls[c].ids;
                if (!ids.length) continue;
                padMax(ids[0], 'before', 12);
                padMax(ids[ids.length - 1], 'after', 12);
            }
        }
    }

    /* 掛在 (父 n, 該側子陣列 kids, 方向 dir) 上的概要們 */
    function summariesOn(n, kids) {
        var out = [];
        for (var i = 0; i < state.summaries.length; i++) {
            var s = state.summaries[i];
            if (s.parentId !== n.id) continue;
            var iF = -1, iT = -1;
            for (var j = 0; j < kids.length; j++) {
                if (kids[j].id === s.fromChildId) iF = j;
                if (kids[j].id === s.toChildId) iT = j;
            }
            if (iF < 0 || iT < 0) continue;
            if (iF > iT) { var t = iF; iF = iT; iT = t; }
            out.push({ s: s, iF: iF, iT: iT });
        }
        return out;
    }

    /* measure 階段（該側子迴圈之後）：回傳 {extraH, needW}，並把墊高寫進 _bPads */
    function adjustSummaries(n, kids, dir, depth, idx) {
        var out = { extraH: 0, needW: 0 };
        var list = summariesOn(n, kids);
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var topic = node(it.s.topicId);
            if (!topic) continue;
            measureNode(topic, depth + 1, idx);
            var rangeH = 0, spanW = 0, rc = 0;
            for (var j = it.iF; j <= it.iT; j++) {
                if (isPinned(kids[j])) continue;
                rangeH += kids[j]._bh;
                if (rc) rangeH += vGap(depth + 1);
                rc++;
                if (kids[j]._bw > spanW) spanW = kids[j]._bw;
            }
            var need = spanW + 22 + topic._bw;
            if (need > out.needW) out.needW = need;
            if (topic._bh > rangeH) {
                var diff = topic._bh - rangeH;
                padAdd(kids[it.iF].id, 'before', diff / 2);
                padAdd(kids[it.iT].id, 'after', diff / 2);
                out.extraH += diff;
            }
        }
        return out;
    }

    /* place 階段（該側子擺位之後）：計算大括號幾何並擺放概要子樹 */
    function placeSummaries(n, kids, dir, depth, idx) {
        var list = summariesOn(n, kids);
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var topic = node(it.s.topicId);
            if (!topic || topic._bw == null) continue;
            var top = Infinity, bot = -Infinity, right = -Infinity, left = Infinity;
            for (var j = it.iF; j <= it.iT; j++) {
                var k = kids[j];
                if (k.cx == null || isPinned(k)) continue;
                var bxL = k.cx - k._ax, bxT = k.cy - k._ay;
                if (bxT < top) top = bxT;
                if (bxT + k._bh > bot) bot = bxT + k._bh;
                if (bxL < left) left = bxL;
                if (bxL + k._bw > right) right = bxL + k._bw;
            }
            if (top === Infinity) continue;
            var bx = (dir > 0) ? right + 8 : left - 8;
            var cy = (top + bot) / 2;
            it.s.__brace = { x: bx, top: top, bot: bot, cy: cy, dir: dir };
            var tLeft = (dir > 0) ? bx + 18 : bx - 18 - topic._bw;
            placeNode(topic, tLeft, cy - topic._ay, depth + 1, idx);
        }
    }

    /* 邏輯圖（右/左）：子節點在單側垂直堆疊（含外框留白與概要空間） */
    function makeLogic(dirSign) {
        return {
            measure: function (n, depth, idx) {
                metricsFor(n, depth);
                var kids = visibleKids(n, idx);
                if (!kids.length) {
                    n._bw = n.w; n._bh = n.h;
                    n._ax = n.w / 2; n._ay = n.h / 2;
                    n._sumH = 0;
                    return;
                }
                var sumH = 0, maxW = 0, i, flowCnt = 0;
                for (i = 0; i < kids.length; i++) {
                    measureNode(kids[i], depth + 1, idx);
                    if (isPinned(kids[i])) continue;             /* 固定位置：不佔直疊空間 */
                    sumH += padOf(kids[i].id, 'before') + kids[i]._bh + padOf(kids[i].id, 'after');
                    if (flowCnt) sumH += vGap(depth + 1);
                    flowCnt++;
                    if (kids[i]._bw > maxW) maxW = kids[i]._bw;
                }
                var adj = adjustSummaries(n, kids, dirSign, depth, idx);
                sumH += adj.extraH;
                if (adj.needW > maxW) maxW = adj.needW;
                n._sumH = sumH;
                n._bw = n.w + hGap(depth + 1) + maxW;
                n._bh = Math.max(n.h, sumH);
                n._ax = (dirSign > 0) ? n.w / 2 : n._bw - n.w / 2;
                n._ay = n._bh / 2;
            },
            place: function (n, bx, by, depth, idx) {
                n.cx = bx + n._ax; n.cy = by + n._ay;
                n.depth = depth; n.dir = dirSign;
                var kids = visibleKids(n, idx);
                if (!kids.length) return;
                var y = by + (n._bh - n._sumH) / 2, i, k, kb;
                for (i = 0; i < kids.length; i++) {
                    k = kids[i];
                    if (isPinned(k)) continue;
                    y += padOf(k.id, 'before');
                    if (dirSign > 0) kb = n.cx + n.w / 2 + hGap(depth + 1);
                    else kb = n.cx - n.w / 2 - hGap(depth + 1) - k._bw;
                    placeNode(k, kb, y, depth + 1, idx);
                    y += k._bh + padOf(k.id, 'after') + vGap(depth + 1);
                }
                for (i = 0; i < kids.length; i++) {
                    k = kids[i];
                    if (!isPinned(k)) continue;
                    placeNode(k, k.posX - k._ax, k.posY - k._ay, depth + 1, idx);
                }
                placeSummaries(n, kids, dirSign, depth, idx);
            },
            anchorOut: function (n) { return anchorOut(n); },
            anchorIn: function (n) { return anchorIn(n); },
            linkPath: function (p, c) { return bezierPath(p, c); },
            togglePos: function (n) {
                return {
                    x: n.cx + dirSign * (n.w / 2 + 12),
                    y: (n.depth >= 2 && !(n._st && n._st.boxed)) ? (n.cy + n.h / 2) : n.cy
                };
            }
        };
    }
    STRUCTURES['logic-right'] = makeLogic(1);
    STRUCTURES['logic-left'] = makeLogic(-1);

    /* 組織圖（向下）：子節點水平成列、父置中於子列上方；肘形連接線 */
    STRUCTURES['org-down'] = {
        measure: function (n, depth, idx) {
            metricsFor(n, depth);
            var kids = visibleKids(n, idx);
            if (!kids.length) {
                n._bw = n.w; n._bh = n.h;
                n._ax = n.w / 2; n._ay = n.h / 2;
                n._sumW = 0;
                return;
            }
            var sumW = 0, maxH = 0, i, fc = 0;
            for (i = 0; i < kids.length; i++) {
                measureNode(kids[i], depth + 1, idx);
                if (isPinned(kids[i])) continue;
                sumW += kids[i]._bw;
                if (fc) sumW += hGapOrg(depth + 1);
                fc++;
                if (kids[i]._bh > maxH) maxH = kids[i]._bh;
            }
            n._sumW = sumW;
            n._bw = Math.max(n.w, sumW);
            n._bh = n.h + vGapOrg(depth + 1) + maxH;
            n._ax = n._bw / 2;
            n._ay = n.h / 2;
        },
        place: function (n, bx, by, depth, idx) {
            n.cx = bx + n._ax; n.cy = by + n._ay;
            n.depth = depth; n.dir = 1;
            var kids = visibleKids(n, idx);
            if (!kids.length) return;
            var x = bx + (n._bw - n._sumW) / 2;
            var rowY = by + n.h + vGapOrg(depth + 1);
            for (var i = 0; i < kids.length; i++) {
                if (isPinned(kids[i])) continue;
                placeNode(kids[i], x, rowY, depth + 1, idx);
                x += kids[i]._bw + hGapOrg(depth + 1);
            }
            for (i = 0; i < kids.length; i++) {
                if (!isPinned(kids[i])) continue;
                placeNode(kids[i], kids[i].posX - kids[i]._ax, kids[i].posY - kids[i]._ay, depth + 1, idx);
            }
        },
        anchorOut: function (n) { return { x: n.cx, y: n.cy + n.h / 2 }; },
        anchorIn: function (n) { return { x: n.cx, y: n.cy - n.h / 2 }; },
        linkPath: function (p, c) {
            var sx = p.cx, sy = p.cy + p.h / 2;
            var ex = c.cx, ey = c.cy - c.h / 2;
            var midY = sy + vGapOrg(c.depth) / 2;
            return 'M' + r2(sx) + ' ' + r2(sy) +
                   ' V ' + r2(midY) +
                   ' H ' + r2(ex) +
                   ' V ' + r2(ey);
        },
        togglePos: function (n) { return { x: n.cx, y: n.cy + n.h / 2 + 12 }; }
    };

    /* 樹狀圖（右下縮排）：子節點在下方向右縮排 28px 直排；肘形連接線 */
    STRUCTURES['tree-right'] = {
        measure: function (n, depth, idx) {
            metricsFor(n, depth);
            var kids = visibleKids(n, idx);
            if (!kids.length) {
                n._bw = n.w; n._bh = n.h;
                n._ax = n.w / 2; n._ay = n.h / 2;
                return;
            }
            var sumH = 0, maxW = 0, i;
            for (i = 0; i < kids.length; i++) {
                measureNode(kids[i], depth + 1, idx);
                if (isPinned(kids[i])) continue;
                sumH += TREE_VGAP + padOf(kids[i].id, 'before') + kids[i]._bh + padOf(kids[i].id, 'after');
                if (kids[i]._bw > maxW) maxW = kids[i]._bw;
            }
            n._bw = Math.max(n.w, TREE_INDENT + maxW);
            n._bh = n.h + sumH;
            n._ax = n.w / 2;
            n._ay = n.h / 2;
        },
        place: function (n, bx, by, depth, idx) {
            n.cx = bx + n._ax; n.cy = by + n._ay;
            n.depth = depth; n.dir = 1;
            var kids = visibleKids(n, idx);
            if (!kids.length) return;
            var y = by + n.h + TREE_VGAP;
            for (var i = 0; i < kids.length; i++) {
                if (isPinned(kids[i])) continue;
                y += padOf(kids[i].id, 'before');
                placeNode(kids[i], bx + TREE_INDENT, y, depth + 1, idx);
                y += kids[i]._bh + padOf(kids[i].id, 'after') + TREE_VGAP;
            }
            for (i = 0; i < kids.length; i++) {
                if (!isPinned(kids[i])) continue;
                placeNode(kids[i], kids[i].posX - kids[i]._ax, kids[i].posY - kids[i]._ay, depth + 1, idx);
            }
        },
        anchorOut: function (n) { return { x: n.cx - n.w / 2 + 12, y: n.cy + n.h / 2 }; },
        anchorIn: function (n) { return { x: n.cx - n.w / 2, y: n.cy }; },
        linkPath: function (p, c) {
            var sx = p.cx - p.w / 2 + 12, sy = p.cy + p.h / 2;
            return 'M' + r2(sx) + ' ' + r2(sy) +
                   ' V ' + r2(c.cy) +
                   ' H ' + r2(c.cx - c.w / 2);
        },
        togglePos: function (n) { return { x: n.cx - n.w / 2 + 12, y: n.cy + n.h / 2 + 10 }; }
    };

    /* 心智圖：中心左右放射＝右側整組 logic-right ＋ 左側整組 logic-left */
    STRUCTURES['mindmap'] = {
        measure: function (n, depth, idx) {
            metricsFor(n, depth);
            var kids = visibleKids(n, idx), i;

            /* 第一層左右平衡（沿 v1：未指定側邊者補到較少的一側，右側優先） */
            var rC = 0, lC = 0;
            for (i = 0; i < kids.length; i++) {
                if (kids[i].side === 'L') lC++;
                else if (kids[i].side === 'R') rC++;
            }
            for (i = 0; i < kids.length; i++) {
                if (kids[i].side !== 'L' && kids[i].side !== 'R') {
                    if (rC <= lC) { kids[i].side = 'R'; rC++; }
                    else { kids[i].side = 'L'; lC++; }
                }
            }

            var right = [], left = [];
            for (i = 0; i < kids.length; i++) (kids[i].side === 'L' ? left : right).push(kids[i]);
            n._mmR = right; n._mmL = left;

            var sumR = 0, maxR = 0, sumL = 0, maxL = 0, fcR = 0, fcL = 0;
            for (i = 0; i < right.length; i++) {
                measureNode(right[i], depth + 1, idx);
                if (isPinned(right[i])) continue;
                sumR += padOf(right[i].id, 'before') + right[i]._bh + padOf(right[i].id, 'after');
                if (fcR) sumR += vGap(depth + 1);
                fcR++;
                if (right[i]._bw > maxR) maxR = right[i]._bw;
            }
            for (i = 0; i < left.length; i++) {
                measureNode(left[i], depth + 1, idx);
                if (isPinned(left[i])) continue;
                sumL += padOf(left[i].id, 'before') + left[i]._bh + padOf(left[i].id, 'after');
                if (fcL) sumL += vGap(depth + 1);
                fcL++;
                if (left[i]._bw > maxL) maxL = left[i]._bw;
            }
            var adjR = adjustSummaries(n, right, 1, depth, idx);
            sumR += adjR.extraH;
            if (adjR.needW > maxR) maxR = adjR.needW;
            var adjL = adjustSummaries(n, left, -1, depth, idx);
            sumL += adjL.extraH;
            if (adjL.needW > maxL) maxL = adjL.needW;
            n._sumR = sumR; n._sumL = sumL;

            var extL = left.length ? hGap(depth + 1) + maxL : 0;
            var extR = right.length ? hGap(depth + 1) + maxR : 0;
            n._bw = extL + n.w + extR;
            n._bh = Math.max(n.h, sumR, sumL);
            n._ax = extL + n.w / 2;
            n._ay = n._bh / 2;
        },
        place: function (n, bx, by, depth, idx) {
            n.cx = bx + n._ax; n.cy = by + n._ay;
            n.depth = depth; n.dir = 1;
            var i, k, y;
            y = n.cy - n._sumR / 2;
            for (i = 0; i < n._mmR.length; i++) {
                k = n._mmR[i];
                if (isPinned(k)) continue;
                y += padOf(k.id, 'before');
                placeNode(k, n.cx + n.w / 2 + hGap(depth + 1), y, depth + 1, idx);
                y += k._bh + padOf(k.id, 'after') + vGap(depth + 1);
            }
            y = n.cy - n._sumL / 2;
            for (i = 0; i < n._mmL.length; i++) {
                k = n._mmL[i];
                if (isPinned(k)) continue;
                y += padOf(k.id, 'before');
                placeNode(k, n.cx - n.w / 2 - hGap(depth + 1) - k._bw, y, depth + 1, idx);
                y += k._bh + padOf(k.id, 'after') + vGap(depth + 1);
            }
            var allKids = n._mmR.concat(n._mmL);
            for (i = 0; i < allKids.length; i++) {
                k = allKids[i];
                if (!isPinned(k)) continue;
                placeNode(k, k.posX - k._ax, k.posY - k._ay, depth + 1, idx);
            }
            placeSummaries(n, n._mmR, 1, depth, idx);
            placeSummaries(n, n._mmL, -1, depth, idx);
        },
        anchorOut: function (n) { return anchorOut(n); },
        anchorIn: function (n) { return anchorIn(n); },
        linkPath: function (p, c) { return bezierPath(p, c); },
        togglePos: function (n) { return { x: n.cx + (n.dir || 1) * (n.w / 2 + 12), y: n.cy }; }
    };

    function layoutAll() {
        var idx = buildChildIndex();
        buildBoundaryPads();   /* P4：外框留白（概要墊高會在各父 measure 時動態加入） */

        /* 中心主題：以 (0,0) 為節點中心（外接框左上角＝負錨點） */
        var central = node(state.centralId);
        if (central) {
            measureNode(central, 0, idx);
            placeNode(central, -central._ax, -central._ay, 0, idx);
        }

        /* 浮動主題：以 (posX,posY) 為根節點中心（P2 起有建立 UI；資料層先支援） */
        var fls = floatingRoots(), i, f;
        for (i = 0; i < fls.length; i++) {
            f = fls[i];
            measureNode(f, 1, idx);
            placeNode(f, f.posX - f._ax, f.posY - f._ay, 1, idx);
        }

        /* 標註 callout：跟著宿主偏移（P2 實作視覺；先給座標避免 NaN） */
        for (var k in state.nodes) {
            var n = state.nodes[k];
            if (n.type !== 'callout') continue;
            var host = node(n.parentId);
            if (!host || host.cx == null) continue;
            metricsFor(n, 2);
            var off = (n.props && n.props.offset) || { dx: 0, dy: -(host.h / 2 + 34) };
            n.cx = host.cx + (off.dx || 0);
            n.cy = host.cy + (off.dy || 0);
            n.depth = 2; n.dir = host.dir || 1;
            n._bw = n.w; n._bh = n.h; n._ax = n.w / 2; n._ay = n.h / 2;
        }
    }

    /* ---------------- SVG 渲染 ---------------- */
    function mk(tag, attrs, textContent) {
        var el = document.createElementNS(SVG_NS, tag);
        if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
        if (textContent != null) el.textContent = textContent;
        return el;
    }
    function r2(v) { return Math.round(v * 100) / 100; }

    function anchorOut(n) {   /* 連往子節點的起點 */
        if (n.depth >= 2) return { x: n.cx + n.dir * n.w / 2, y: n.cy + n.h / 2 };
        return { x: n.cx + n.dir * n.w / 2, y: n.cy };
    }
    function anchorIn(n) {    /* 從父節點連入的終點 */
        if (n.depth >= 2) return { x: n.cx - n.dir * n.w / 2, y: n.cy + n.h / 2 };
        return { x: n.cx - n.dir * n.w / 2, y: n.cy };
    }

    /* logic／mindmap 的三次貝茲（v1 原線形）。
       ★ 跨結構銜接規則：連接線用「父策略」的 linkPath——形狀跟著父走、端點跟著子走。 */
    function bezierPath(p, c) {
        var dir = c.dir;
        var s = (p.depth === 0) ? { x: p.cx + dir * (p.w / 2 - 4), y: p.cy } : anchorOut(p);
        var e = anchorIn(c);
        var dx = Math.abs(e.x - s.x);
        var c1x = s.x + dir * Math.max(18, dx * 0.4);
        var c2x = e.x - dir * Math.max(12, dx * 0.3);
        return 'M' + r2(s.x) + ' ' + r2(s.y) +
               ' C ' + r2(c1x) + ' ' + r2(s.y) + ', ' + r2(c2x) + ' ' + r2(e.y) + ', ' + r2(e.x) + ' ' + r2(e.y);
    }

    function drawLink(p, c, layer) {
        var stg = STRUCTURES[structureOf(p)] || STRUCTURES['logic-right'];
        var d = stg.linkPath ? stg.linkPath(p, c) : bezierPath(p, c);
        layer.appendChild(mk('path', {
            d: d, fill: 'none',
            stroke: effColor(c),
            'stroke-width': linkWidth(c.depth),
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'data-cid': c.id
        }));
    }

    function drawNode(n, layer, idx) {
        var g = mk('g', { 'class': 'mm-node', 'data-id': n.id });
        var st = n._st || styleFor(n.depth || 0, structureOf(n));
        var th = themeOf();
        var pr = n.props || {};
        var branch = (n.depth === 0) ? th.rootFill : effColor(n);

        /* 有效繪製樣式：主題預設（依 depth/structure）⊕ props 覆寫 */
        var defShape = (n.depth <= 1) ? 'rounded' : (st.boxed ? 'rect' : 'underline');
        var shape = pr.shape || defShape;
        var fill = null;
        if (shape !== 'underline' && shape !== 'none') {
            if (pr.fill != null) fill = pr.fill;
            else if (n.depth <= 1) fill = branch;
            else fill = th.plainFill;
        }
        var border = null;
        if (pr.border) {
            border = {
                color: pr.border.color || branch,
                width: pr.border.width || 2,
                dash: pr.border.dash === 'dash' ? '6 4' : null
            };
        } else if (shape !== 'underline' && shape !== 'none') {
            border = (n.depth <= 1)
                ? { color: 'rgba(0,0,0,0.10)', width: 1, dash: null }
                : { color: branch, width: 1.6, dash: null };
        }
        var textColor = fill ? (isDarkColor(fill) ? '#FFFFFF' : th.inkOnLight) : th.ink;
        if (pr.font && pr.font.color) textColor = pr.font.color;
        var italic = !!(pr.font && pr.font.italic);

        var L = n.cx - n.w / 2, T = n.cy - n.h / 2;

        if (shape === 'underline') {
            g.appendChild(mk('rect', {
                x: r2(L - 3), y: r2(T - 3),
                width: r2(n.w + 6), height: r2(n.h + 6),
                fill: 'rgba(0,0,0,0)'
            }));
            var up = {
                d: 'M ' + r2(L) + ' ' + r2(n.cy + n.h / 2) + ' H ' + r2(L + n.w),
                stroke: (pr.border && pr.border.color) || branch,
                'stroke-width': (pr.border && pr.border.width) || 2,
                fill: 'none', 'stroke-linecap': 'round'
            };
            if (pr.border && pr.border.dash === 'dash') up['stroke-dasharray'] = '6 4';
            g.appendChild(mk('path', up));
        } else if (shape === 'none') {
            g.appendChild(mk('rect', {
                x: r2(L - 3), y: r2(T - 3),
                width: r2(n.w + 6), height: r2(n.h + 6),
                fill: 'rgba(0,0,0,0)'
            }));
        } else {
            var attrs = { fill: fill || 'none' };
            if (border) {
                attrs.stroke = border.color;
                attrs['stroke-width'] = border.width;
                if (border.dash) attrs['stroke-dasharray'] = border.dash;
            }
            g.appendChild(shapeEl(shape, L, T, n.w, n.h, st.radius, attrs));
        }

        var reg = n._regions || { text: { x: st.padX, y: st.padY, w: n.w - st.padX * 2, h: n.h - st.padY * 2 } };
        var aligned = !!reg.aligned;

        /* 標記（emoji 前綴，首行左側） */
        if (reg.markers) {
            var mtx = mk('text', { 'font-family': FONT_FAMILY, 'font-size': st.fs, 'text-anchor': 'start' });
            mtx.appendChild(mk('tspan', {
                x: r2(L + reg.markers.x),
                y: r2(T + reg.markers.y + st.lineH * 0.5),
                'dominant-baseline': 'central'
            }, reg.markers.list.join(' ')));
            g.appendChild(mtx);
        }

        /* 主文字 */
        var txt = mk('text', {
            'font-family': FONT_FAMILY, 'font-size': st.fs, 'font-weight': st.fw,
            fill: textColor, 'text-anchor': aligned ? 'start' : 'middle'
        });
        if (italic) txt.setAttribute('font-style', 'italic');
        var top = T + reg.text.y;
        var txAnchor = aligned ? (L + reg.text.x) : n.cx;
        for (var i = 0; i < n._lines.length; i++) {
            txt.appendChild(mk('tspan', {
                x: r2(txAnchor),
                y: r2(top + st.lineH * (i + 0.5)),
                'dominant-baseline': 'central'
            }, n._lines[i]));
        }
        g.appendChild(txt);

        /* 右側小圖示：🔗（連結）／📝（備註，含 title 提示） */
        if (reg.icons) {
            var ix = L + reg.icons.x;
            for (var ii = 0; ii < reg.icons.list.length; ii++) {
                var kind = reg.icons.list[ii];
                var it = mk('text', {
                    x: r2(ix), y: r2(T + reg.icons.y + st.lineH * 0.5),
                    'font-size': Math.max(11, st.fs - 1),
                    'text-anchor': 'start', 'dominant-baseline': 'central',
                    cursor: 'pointer',
                    'data-icon': kind, 'data-icon-for': n.id
                }, kind === 'link' ? '🔗' : '📝');
                it.setAttribute('style', 'pointer-events:auto;');
                if (kind === 'note' && pr.note) {
                    var ti = mk('title', {});
                    ti.textContent = ('' + pr.note).slice(0, 120);
                    it.appendChild(ti);
                }
                g.appendChild(it);
                ix += st.fs + 4;
            }
        }

        /* 圖片 */
        if (reg.image) {
            var ig = mk('image', {
                x: r2(L + reg.image.x), y: r2(T + reg.image.y),
                width: r2(reg.image.w), height: r2(reg.image.h),
                href: fileUrl(reg.image.fileId), 'data-image-for': n.id,
                style: 'cursor:pointer;'
            });
            ig.setAttributeNS('http://www.w3.org/1999/xlink', 'href', fileUrl(reg.image.fileId));
            g.appendChild(ig);
            g.appendChild(mk('rect', {
                x: r2(L + reg.image.x), y: r2(T + reg.image.y),
                width: r2(reg.image.w), height: r2(reg.image.h),
                rx: 4, fill: 'none', stroke: 'rgba(0,0,0,0.10)', 'stroke-width': 1
            }));
        }

        /* 附檔清單：📎 檔名（點擊下載） */
        if (reg.attachments) {
            var ay = T + reg.attachments.y;
            for (var ati = 0; ati < reg.attachments.list.length; ati++) {
                var a = reg.attachments.list[ati];
                var at = mk('text', {
                    x: r2(L + reg.attachments.x), y: r2(ay + 9),
                    'font-family': FONT_FAMILY, 'font-size': 11.5,
                    'text-anchor': 'start', 'dominant-baseline': 'central',
                    fill: textColor, cursor: 'pointer',
                    'data-attach': a.fileId, 'data-attach-for': n.id,
                    style: 'pointer-events:auto;'
                }, '📎 ' + (a.fileName || ''));
                g.appendChild(at);
                ay += 18;
            }
        }

        /* 摺疊／展開鈕（中心主題不提供） */
        var kids = idx[n.id] || [];
        if (kids.length && n.id !== state.centralId) {
            var stg = STRUCTURES[structureOf(n)] || STRUCTURES['logic-right'];
            var tp = stg.togglePos ? stg.togglePos(n)
                                   : { x: n.cx + n.dir * (n.w / 2 + 12), y: n.cy };
            var bx = tp.x;
            var by = tp.y;
            var tg = mk('g', {
                'class': 'mm-toggle' + (n.collapsed ? ' on' : ''),
                'data-toggle': n.id
            });
            tg.appendChild(mk('circle', { cx: r2(bx), cy: r2(by), r: 8, fill: th.plainFill, stroke: branch, 'stroke-width': 1.5 }));
            tg.appendChild(mk('text', {
                x: r2(bx), y: r2(by), 'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': 10, 'font-family': FONT_FAMILY, fill: branch
            }, n.collapsed ? String(countDesc(n.id)) : '−'));
            g.appendChild(tg);
        }
        layer.appendChild(g);
    }

    /* 標註泡泡：深底白字圓角矩形＋依 offset 主軸指回宿主的小三角尾巴 */
    function drawCallout(n, layer) {
        var g = mk('g', { 'class': 'mm-node mm-callout', 'data-id': n.id });
        var fill = '#3E4C59';
        var off = (n.props && n.props.offset) || { dx: 0, dy: 0 };
        var L = n.cx - n.w / 2, R = n.cx + n.w / 2, T = n.cy - n.h / 2, B = n.cy + n.h / 2;
        var tail;
        if (Math.abs(off.dy) >= Math.abs(off.dx)) {
            tail = (off.dy <= 0)
                ? ('M ' + r2(n.cx - 6) + ' ' + r2(B) + ' L ' + r2(n.cx + 6) + ' ' + r2(B) + ' L ' + r2(n.cx) + ' ' + r2(B + 10) + ' Z')
                : ('M ' + r2(n.cx - 6) + ' ' + r2(T) + ' L ' + r2(n.cx + 6) + ' ' + r2(T) + ' L ' + r2(n.cx) + ' ' + r2(T - 10) + ' Z');
        } else {
            tail = (off.dx >= 0)
                ? ('M ' + r2(L) + ' ' + r2(n.cy - 6) + ' L ' + r2(L) + ' ' + r2(n.cy + 6) + ' L ' + r2(L - 10) + ' ' + r2(n.cy) + ' Z')
                : ('M ' + r2(R) + ' ' + r2(n.cy - 6) + ' L ' + r2(R) + ' ' + r2(n.cy + 6) + ' L ' + r2(R + 10) + ' ' + r2(n.cy) + ' Z');
        }
        g.appendChild(mk('path', { d: tail, fill: fill }));
        g.appendChild(mk('rect', {
            x: r2(L), y: r2(T), width: r2(n.w), height: r2(n.h),
            rx: 8, fill: fill, stroke: 'rgba(0,0,0,0.15)', 'stroke-width': 1
        }));
        var st = n._st || styleFor(2);
        var txt = mk('text', {
            'font-family': FONT_FAMILY, 'font-size': st.fs, 'font-weight': 500,
            fill: '#FFFFFF', 'text-anchor': 'middle'
        });
        var top = n.cy - n.h / 2 + st.padY;
        var lines = n._lines || [];
        for (var i = 0; i < lines.length; i++) {
            txt.appendChild(mk('tspan', {
                x: r2(n.cx),
                y: r2(top + st.lineH * (i + 0.5)),
                'dominant-baseline': 'central'
            }, lines[i]));
        }
        g.appendChild(txt);
        layer.appendChild(g);
    }

    /* ---------------- P3：關聯線幾何與繪製 ---------------- */
    var REL_COLOR = '#3FA46A';
    var _arrowCache = {};

    /* SVG marker 不吃 path 的 stroke 色（十大地雷之一）→ 每個顏色動態建一個 marker 並快取 */
    function ensureArrowMarker(color) {
        var key = ('' + color).replace(/[^0-9A-Za-z]/g, '');
        var id = 'mmArrow-' + key;
        if (_arrowCache[id]) return id;
        _arrowCache[id] = true;
        if (els.svgDefs) {
            var m = mk('marker', {
                id: id, viewBox: '0 0 10 10', refX: 8.5, refY: 5,
                markerWidth: 6, markerHeight: 6, orient: 'auto'
            });
            m.appendChild(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
            els.svgDefs.appendChild(m);
        }
        return id;
    }

    /* 端點：依兩中心連線主軸，各取左右緣或上下緣中點 */
    function relAnchors(a, b) {
        var dx = b.cx - a.cx, dy = b.cy - a.cy;
        if (Math.abs(dx) >= Math.abs(dy)) {
            return {
                s: { x: a.cx + (dx >= 0 ? a.w / 2 : -a.w / 2), y: a.cy },
                e: { x: b.cx + (dx >= 0 ? -b.w / 2 : b.w / 2), y: b.cy }
            };
        }
        return {
            s: { x: a.cx, y: a.cy + (dy >= 0 ? a.h / 2 : -a.h / 2) },
            e: { x: b.cx, y: b.cy + (dy >= 0 ? -b.h / 2 : b.h / 2) }
        };
    }

    /* 對稱貝茲通過中點 (mx,my)；無 bend 時中垂隆起 bulge=min(80, dist*0.25)。
       __pv＝拖曳控制柄時的即時預覽。 */
    function relPathD(r, a, b) {
        var an = relAnchors(a, b), s = an.s, e = an.e;
        var mx, my;
        if (r.__pv) {
            mx = r.__pv.mx; my = r.__pv.my;
        } else {
            var pr = safeParseProps(r.props);
            if (pr && pr.bend && typeof pr.bend.mx === 'number' && typeof pr.bend.my === 'number') {
                mx = pr.bend.mx; my = pr.bend.my;
            } else {
                var cx0 = (s.x + e.x) / 2, cy0 = (s.y + e.y) / 2;
                var vx = e.x - s.x, vy = e.y - s.y;
                var dist = Math.sqrt(vx * vx + vy * vy) || 1;
                var bulge = Math.min(80, dist * 0.25);
                mx = cx0 - vy / dist * bulge;
                my = cy0 + vx / dist * bulge;
            }
        }
        var qx = 2 * mx - (s.x + e.x) / 2;
        var qy = 2 * my - (s.y + e.y) / 2;
        return {
            d: 'M' + r2(s.x) + ' ' + r2(s.y) + ' Q ' + r2(qx) + ' ' + r2(qy) + ' ' + r2(e.x) + ' ' + r2(e.y),
            s: s, e: e, mx: mx, my: my
        };
    }

    function drawRelations(visSet) {
        if (!els.relLayer) return;
        for (var i = 0; i < state.relations.length; i++) {
            var r = state.relations[i];
            var a = node(r.fromId), b = node(r.toId);
            if (!a || !b || a.cx == null || b.cx == null) continue;
            if (visSet && (!visSet[a.id] || !visSet[b.id])) continue;   /* 端點被摺疊隱藏就不畫 */
            var pd = relPathD(r, a, b);
            var color = REL_COLOR;
            var markerId = ensureArrowMarker(color);
            var sel = (state.selectedRelId === r.relId);
            els.relLayer.appendChild(mk('path', {
                d: pd.d, fill: 'none',
                stroke: color, 'stroke-width': sel ? 2.6 : 2,
                'stroke-dasharray': '7 5', 'stroke-linecap': 'round',
                'marker-end': 'url(#' + markerId + ')',
                'data-rel': r.relId
            }));
            /* 命中線：同路徑、12px 透明粗線，方便點選 */
            els.relLayer.appendChild(mk('path', {
                d: pd.d, fill: 'none',
                stroke: 'rgba(0,0,0,0)', 'stroke-width': 12,
                'data-rel': r.relId, 'class': 'mm-rel-hit'
            }));
            if (r.label) {
                var est = Math.max(24, ('' + r.label).length * 13 + 12);
                var lg = mk('g', { 'data-rel': r.relId, 'class': 'mm-rel-label' });
                lg.appendChild(mk('rect', {
                    x: r2(pd.mx - est / 2), y: r2(pd.my - 10),
                    width: r2(est), height: 20, rx: 5,
                    fill: '#FFFFFF', stroke: color, 'stroke-width': 1
                }));
                lg.appendChild(mk('text', {
                    x: r2(pd.mx), y: r2(pd.my),
                    'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-family': FONT_FAMILY, 'font-size': 12.5, fill: '#2F3B33'
                }, '' + r.label));
                els.relLayer.appendChild(lg);
            }
        }
    }

    /* 關聯線選取：兩端小圓＋中點方形控制柄（拖曳＝調整彎曲） */
    function drawRelSelection(layer) {
        var r = findRel(state.selectedRelId);
        if (!r) { state.selectedRelId = null; return false; }
        var a = node(r.fromId), b = node(r.toId);
        if (!a || !b || a.cx == null || b.cx == null) return true;
        var pd = relPathD(r, a, b);
        layer.appendChild(mk('circle', { cx: r2(pd.s.x), cy: r2(pd.s.y), r: 4.5, fill: SEL_COLOR }));
        layer.appendChild(mk('circle', { cx: r2(pd.e.x), cy: r2(pd.e.y), r: 4.5, fill: SEL_COLOR }));
        layer.appendChild(mk('rect', {
            x: r2(pd.mx - 5), y: r2(pd.my - 5), width: 10, height: 10, rx: 2,
            fill: '#FFFFFF', stroke: SEL_COLOR, 'stroke-width': 2,
            cursor: 'grab', 'data-relhandle': r.relId
        }));
        return true;
    }

    /* ---------------- P4：外框與概要繪製 ---------------- */
    /* 群組成員：新格式直接取 memberIds；舊格式（parentId＋兄弟區間）自動展開。
       只收目前存在、且 type='topic' 的節點。 */
    function normalizeMembers(b) {
        var raw = [], i;
        if (b && b.memberIds && b.memberIds.length) {
            raw = b.memberIds;
        } else if (b && b.parentId && b.fromChildId && b.toChildId) {
            var sibs = rangeSibs(b.parentId, b.fromChildId);
            var iF = -1, iT = -1;
            for (i = 0; i < sibs.length; i++) {
                if (sibs[i].id === b.fromChildId) iF = i;
                if (sibs[i].id === b.toChildId) iT = i;
            }
            if (iF >= 0 && iT >= 0) {
                if (iF > iT) { var tmp = iF; iF = iT; iT = tmp; }
                for (i = iF; i <= iT; i++) raw.push(sibs[i].id);
            }
        }
        var out = [], seen = {};
        for (i = 0; i < raw.length; i++) {
            var id = raw[i], n = node(id);
            if (!id || seen[id] || !n || n.type !== 'topic' || !n.parentId) continue;
            seen[id] = 1;
            out.push(id);
        }
        return out;
    }

    /* 自動分簇：把成員切成「同父層＋同側＋連續兄弟」的區段，每段畫一個虛線框。
       選連續兄弟時只會有一簇（＝與舊版外框行為完全相同）；
       跨層級或不連續的選取則畫成數個框，避免一個巨框把不相干的節點吞進去。 */
    function boundaryClusters(b) {
        var ids = normalizeMembers(b), i, j;

        /* 祖先也在群組內 → 成員被祖先的子樹吸收，不另外成簇 */
        var kept = [];
        for (i = 0; i < ids.length; i++) {
            var absorbed = false;
            for (j = 0; j < ids.length; j++) {
                if (i !== j && isDescendant(ids[j], ids[i])) { absorbed = true; break; }
            }
            if (!absorbed) kept.push(ids[i]);
        }

        /* 依（父節點＋側邊）分組：中心主題底下的 mindmap 結構左右各自成組 */
        var groups = {}, order = [];
        for (i = 0; i < kept.length; i++) {
            var n = node(kept[i]), pN = node(n.parentId);
            var key = n.parentId + '|';
            if (pN && n.parentId === state.centralId && structureOf(pN) === 'mindmap') key += sideOf(n);
            if (!groups[key]) { groups[key] = { parentId: n.parentId, ids: [] }; order.push(key); }
            groups[key].ids.push(kept[i]);
        }

        /* 每組內依兄弟順序排序，切成連續區段 */
        var out = [];
        for (var g = 0; g < order.length; g++) {
            var grp = groups[order[g]];
            var sibs = rangeSibs(grp.parentId, grp.ids[0]);
            var idxOf = {};
            for (i = 0; i < sibs.length; i++) idxOf[sibs[i].id] = i;
            var mem = [];
            for (i = 0; i < grp.ids.length; i++) {
                if (idxOf[grp.ids[i]] === undefined) continue;
                mem.push({ id: grp.ids[i], i: idxOf[grp.ids[i]] });
            }
            mem.sort(function (a, c) { return a.i - c.i; });
            var run = [];
            for (i = 0; i < mem.length; i++) {
                if (run.length && mem[i].i !== mem[i - 1].i + 1) {
                    out.push({ parentId: grp.parentId, ids: run });
                    run = [];
                }
                run.push(mem[i].id);
            }
            if (run.length) out.push({ parentId: grp.parentId, ids: run });
        }
        return out;
    }

    /* 單一簇的外接框（含成員子樹） */
    function clusterBox(ids) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < ids.length; i++) {
            var k = node(ids[i]);
            if (!k || isPinned(k)) continue;   /* 固定位置的成員不入框（框住流內成員） */
            if (k.cx == null) return null;
            var L = k.cx - k._ax, T = k.cy - k._ay;
            if (L < minX) minX = L;
            if (T < minY) minY = T;
            if (L + k._bw > maxX) maxX = L + k._bw;
            if (T + k._bh > maxY) maxY = T + k._bh;
        }
        if (minX === Infinity) return null;
        var pad = 12;
        return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    }

    /* 代表框（第一個可見簇）：標籤編輯等定位用 */
    function boundaryRangeBox(b) {
        var cls = boundaryClusters(b);
        for (var c = 0; c < cls.length; c++) {
            var pN = node(cls[c].parentId);
            if (!pN || pN.collapsed) continue;
            var box = clusterBox(cls[c].ids);
            if (box) return box;
        }
        return null;
    }

    function drawBoundaries(visSet) {
        if (!els.boundaryLayer) return;
        for (var i = 0; i < state.boundaries.length; i++) {
            var b = state.boundaries[i];
            var pr = safeParseProps(b.props);
            var cls = boundaryClusters(b);
            var firstBox = null, firstCol = null;
            for (var c = 0; c < cls.length; c++) {
                var cl = cls[c];
                var pN = node(cl.parentId);
                if (!pN || pN.collapsed || !visSet[cl.parentId]) continue;
                var box = clusterBox(cl.ids);
                if (!box) continue;
                var col = (pr && pr.color) ? pr.color : effColor(node(cl.ids[0]) || {});
                /* 面：不吃事件（框內仍可平移/點節點）；框緣另畫 10px 命中帶 */
                els.boundaryLayer.appendChild(mk('rect', {
                    x: r2(box.x), y: r2(box.y), width: r2(box.w), height: r2(box.h),
                    rx: 14, fill: col + '14', stroke: col, 'stroke-width': 1.6,
                    'stroke-dasharray': '6 5', 'pointer-events': 'none'
                }));
                els.boundaryLayer.appendChild(mk('rect', {
                    x: r2(box.x), y: r2(box.y), width: r2(box.w), height: r2(box.h),
                    rx: 14, fill: 'none', stroke: 'rgba(0,0,0,0)', 'stroke-width': 10,
                    'pointer-events': 'stroke', 'data-boundary': b.boundaryId
                }));
                if (!firstBox) { firstBox = box; firstCol = col; }
            }
            /* 標籤只掛在第一個簇上 */
            if (b.label && firstBox) {
                var est = Math.max(20, ('' + b.label).length * 12 + 10);
                var lg = mk('g', { 'data-boundary': b.boundaryId });
                lg.appendChild(mk('rect', {
                    x: r2(firstBox.x + 12), y: r2(firstBox.y - 9), width: r2(est), height: 18, rx: 4,
                    fill: '#FFFFFF', stroke: firstCol, 'stroke-width': 1
                }));
                lg.appendChild(mk('text', {
                    x: r2(firstBox.x + 12 + est / 2), y: r2(firstBox.y),
                    'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-family': FONT_FAMILY, 'font-size': 11.5, fill: firstCol
                }, '' + b.label));
                els.boundaryLayer.appendChild(lg);
            }
        }
    }

    function drawSummaries(visSet) {
        if (!els.summaryLayer) return;
        for (var i = 0; i < state.summaries.length; i++) {
            var s = state.summaries[i];
            var pN = node(s.parentId), tN = node(s.topicId);
            if (!pN || pN.collapsed || !visSet[pN.id]) continue;
            if (!s.__brace || !tN || tN.cx == null) continue;
            var col = effColor(node(s.fromChildId) || tN);
            var bg = s.__brace, o = bg.dir > 0 ? 1 : -1;
            var d = 'M ' + r2(bg.x) + ' ' + r2(bg.top) +
                    ' C ' + r2(bg.x + 10 * o) + ' ' + r2(bg.top) + ' ' +
                            r2(bg.x + 10 * o) + ' ' + r2(bg.cy - 6) + ' ' +
                            r2(bg.x + 14 * o) + ' ' + r2(bg.cy) +
                    ' C ' + r2(bg.x + 10 * o) + ' ' + r2(bg.cy + 6) + ' ' +
                            r2(bg.x + 10 * o) + ' ' + r2(bg.bot) + ' ' +
                            r2(bg.x) + ' ' + r2(bg.bot);
            els.summaryLayer.appendChild(mk('path', {
                d: d, fill: 'none', stroke: col, 'stroke-width': 2,
                'stroke-linecap': 'round', 'data-summary': s.summaryId
            }));
            els.summaryLayer.appendChild(mk('path', {
                d: d, fill: 'none', stroke: 'rgba(0,0,0,0)', 'stroke-width': 12,
                'data-summary': s.summaryId
            }));
        }
    }

    function drawBoundarySelection(layer) {
        var b = findBoundary(state.selectedBoundaryId);
        if (!b) { state.selectedBoundaryId = null; return false; }
        var box = boundaryRangeBox(b);
        if (!box) return true;
        layer.appendChild(mk('rect', {
            x: r2(box.x - 2), y: r2(box.y - 2), width: r2(box.w + 4), height: r2(box.h + 4),
            rx: 16, fill: 'none', stroke: SEL_COLOR, 'stroke-width': 2
        }));
        return true;
    }

    function drawSelection(layer) {
        if (state.selectedBoundaryId) {
            if (drawBoundarySelection(layer)) return;
        }
        if (state.selectedRelId) {
            if (drawRelSelection(layer)) return;
        }
        var list = state.selectedIds.length ? state.selectedIds
                 : (state.selectedId ? [state.selectedId] : []);
        for (var i = 0; i < list.length; i++) {
            var n = node(list[i]);
            if (!n || n.cx == null) continue;
            var main = (list[i] === state.selectedId);
            layer.appendChild(mk('rect', {
                x: r2(n.cx - n.w / 2 - 4), y: r2(n.cy - n.h / 2 - 4),
                width: r2(n.w + 8), height: r2(n.h + 8),
                rx: (n._st ? n._st.radius : 8) + 2,
                fill: 'none', stroke: SEL_COLOR, 'stroke-width': main ? 2 : 1.2
            }));
        }
    }

    function render() {
        if (!els.linkLayer) return;
        if (els.boundaryLayer) els.boundaryLayer.textContent = '';
        els.linkLayer.textContent = '';
        if (els.summaryLayer) els.summaryLayer.textContent = '';
        if (els.relLayer) els.relLayer.textContent = '';
        els.nodeLayer.textContent = '';
        els.overlayLayer.textContent = '';
        var central = node(state.centralId);
        if (!central) { updateStatus(); return; }

        var idx = buildChildIndex();
        var order = [];
        var visSet = {};
        function walk(id) {
            var n = node(id);
            if (!n) return;
            order.push(n);
            visSet[n.id] = true;
            if (n.collapsed) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(state.centralId);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) walk(fls[fi].id);

        /* 概要主題（含其子樹）補進走訪——父可見且未摺疊才顯示 */
        for (var si = 0; si < state.summaries.length; si++) {
            var sRec = state.summaries[si];
            var sp = node(sRec.parentId);
            var stp = node(sRec.topicId);
            if (!sp || sp.collapsed || !visSet[sp.id]) continue;
            if (!stp || stp.cx == null) continue;
            walk(sRec.topicId);
        }

        for (var i = 0; i < order.length; i++) {
            if (order[i].parentId && order[i].type !== 'summary') {   /* 概要主題以大括號連接，不畫親子線 */
                var p = node(order[i].parentId);
                if (p && p.cx != null) drawLink(p, order[i], els.linkLayer);
            }
        }
        for (i = 0; i < order.length; i++) drawNode(order[i], els.nodeLayer, idx);

        /* 標註：宿主有畫出來才畫（宿主被摺疊隱藏時一併隱藏） */
        for (var ck in state.nodes) {
            var cn = state.nodes[ck];
            if (cn.type !== 'callout') continue;
            if (!visSet[cn.parentId] || cn.cx == null) continue;
            drawCallout(cn, els.nodeLayer);
        }

        drawBoundaries(visSet);
        drawSummaries(visSet);
        drawRelations(visSet);

        drawSelection(els.overlayLayer);
        refreshStylePanel();
        updateStatus();
    }

    function setViewport() {
        els.viewport.setAttribute('transform',
            'translate(' + r2(state.panX) + ' ' + r2(state.panY) + ') scale(' + r2(state.scale) + ')');
        if (els.zoomLabel) els.zoomLabel.textContent = Math.round(state.scale * 100) + '%';
        updateStatus();
    }

    function screenToWorld(mx, my) {
        var rect = els.svg.getBoundingClientRect();
        return {
            x: (mx - rect.left - state.panX) / state.scale,
            y: (my - rect.top - state.panY) / state.scale
        };
    }

    function nodeScreenRect(n) {
        return {
            left: state.panX + state.scale * (n.cx - n.w / 2),
            top: state.panY + state.scale * (n.cy - n.h / 2),
            width: state.scale * n.w,
            height: state.scale * n.h
        };
    }

    function contentBBox() {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
        var idx = buildChildIndex();
        function walk(id) {
            var n = node(id);
            if (!n || n.cx == null) return;
            any = true;
            minX = Math.min(minX, n.cx - n.w / 2);
            maxX = Math.max(maxX, n.cx + n.w / 2 + 20); /* 預留摺疊鈕 */
            minY = Math.min(minY, n.cy - n.h / 2);
            maxY = Math.max(maxY, n.cy + n.h / 2);
            if (n.collapsed) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(state.centralId);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) walk(fls[fi].id);
        for (var sci = 0; sci < state.summaries.length; sci++) {
            var sp0 = node(state.summaries[sci].parentId);
            if (!sp0 || sp0.collapsed) continue;
            walk(state.summaries[sci].topicId);
        }
        if (!any) return { x: -100, y: -60, w: 200, h: 120 };
        return { x: minX - 20, y: minY, w: (maxX - minX) + 20, h: maxY - minY };
    }

    function fitView() {
        var vw = els.stage.clientWidth, vh = els.stage.clientHeight;
        if (!vw || !vh) { state.scale = 1; state.panX = 400; state.panY = 300; setViewport(); return; }
        var bb = contentBBox();
        var margin = 60;
        var s = Math.min((vw - margin * 2) / bb.w, (vh - margin * 2) / bb.h);
        s = Math.max(0.25, Math.min(1.25, s));
        state.scale = s;
        state.panX = vw / 2 - s * (bb.x + bb.w / 2);
        state.panY = vh / 2 - s * (bb.y + bb.h / 2);
        setViewport();
    }

    function zoomAt(mx, my, factor) {
        var rect = els.svg.getBoundingClientRect();
        var px = mx - rect.left, py = my - rect.top;
        var wx = (px - state.panX) / state.scale;
        var wy = (py - state.panY) / state.scale;
        var s2 = Math.max(0.25, Math.min(3, state.scale * factor));
        state.panX = px - wx * s2;
        state.panY = py - wy * s2;
        state.scale = s2;
        setViewport();
    }

    function zoomStep(delta) {
        var vw = els.stage.clientWidth, vh = els.stage.clientHeight;
        var rect = els.svg.getBoundingClientRect();
        zoomAt(rect.left + vw / 2, rect.top + vh / 2, delta);
    }

    function ensureVisible(n) {
        if (!n || n.cx == null) return;
        var vw = els.stage.clientWidth, vh = els.stage.clientHeight;
        if (!vw || !vh) return;
        var r = nodeScreenRect(n), m = 30, moved = false;
        if (r.left < m) { state.panX += m - r.left; moved = true; }
        if (r.top < m + 0) { state.panY += m - r.top; moved = true; }
        if (r.left + r.width > vw - m) { state.panX -= (r.left + r.width) - (vw - m); moved = true; }
        if (r.top + r.height > vh - m) { state.panY -= (r.top + r.height) - (vh - m); moved = true; }
        if (moved) setViewport();
    }

    /* ---------------- 復原 / 重做（快照＝完整 doc） ---------------- */
    function snapshot() {
        return JSON.stringify(serializeDoc());
    }
    function restore(snap) {
        try {
            hydrateDoc(JSON.parse(snap));
            if (els.mapTitle) els.mapTitle.value = state.title;
            if (!node(state.selectedId)) state.selectedId = state.centralId;
            state.selectedIds = state.selectedId ? [state.selectedId] : [];
            if (state.selectedRelId && !findRel(state.selectedRelId)) state.selectedRelId = null;
            if (state.selectedBoundaryId && !findBoundary(state.selectedBoundaryId)) state.selectedBoundaryId = null;
            applyTheme();
            markDirty();
            layoutAll();
            render();
        } catch (e) { /* 快照損毀時不動作 */ }
    }
    function pushUndo() {
        state.undoStack.push(snapshot());
        if (state.undoStack.length > 100) state.undoStack.shift();
        state.redoStack.length = 0;
    }
    function undo() {
        if (!state.undoStack.length) return;
        state.redoStack.push(snapshot());
        restore(state.undoStack.pop());
    }
    function redo() {
        if (!state.redoStack.length) return;
        state.undoStack.push(snapshot());
        restore(state.redoStack.pop());
    }

    /* ---------------- 節點操作 ---------------- */
    function uid() {
        try {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
        } catch (e) { }
        return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function markDirty() {
        state.dirty = true;
        updateSaveUI();
    }

    function afterMutate() {
        markDirty();
        layoutAll();
        render();
    }

    function normalizeOrders(parentId) {
        var sibs = childrenOf(parentId);
        for (var i = 0; i < sibs.length; i++) sibs[i].sortOrder = (i + 1) * 10;
    }

    function select(id) {
        state.selectedId = id;
        state.selectedIds = id ? [id] : [];
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        render();
        ensureVisible(node(id));
    }

    /* Ctrl/Cmd＋點：任意 toggle 多選 */
    function toggleSelect(id) {
        if (!node(id)) return;
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        var i = state.selectedIds.indexOf(id);
        if (i >= 0) {
            state.selectedIds.splice(i, 1);
            if (state.selectedId === id) {
                state.selectedId = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : null;
            }
        } else {
            state.selectedIds.push(id);
            state.selectedId = id;
        }
        render();
    }

    /* Shift＋點：以主選取為錨的連續兄弟區間（中心心智圖限同側） */
    function rangeSelect(anchorId, id) {
        var a = node(anchorId), b = node(id);
        if (!a || !b || !a.parentId || a.parentId !== b.parentId) { select(id); return; }
        var sibs = rangeSibs(a.parentId, anchorId);
        var iA = -1, iB = -1;
        for (var i = 0; i < sibs.length; i++) {
            if (sibs[i].id === anchorId) iA = i;
            if (sibs[i].id === id) iB = i;
        }
        if (iA < 0 || iB < 0) { select(id); return; }
        var lo = Math.min(iA, iB), hi = Math.max(iA, iB);
        state.selectedIds = [];
        for (i = lo; i <= hi; i++) state.selectedIds.push(sibs[i].id);
        state.selectedId = id;
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        render();
    }

    /* 在多選中換主選取而不打散選取（右鍵用） */
    function setPrimary(id) {
        if (state.selectedIds.indexOf(id) < 0) { select(id); return; }
        state.selectedId = id;
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        render();
    }

    function addChild(parentId, text) {
        var p = node(parentId);
        if (!p) return null;
        if (p.type === 'callout') return null;   /* 標註不能生子；概要主題可長子樹 */
        pushUndo();
        if (p.collapsed) p.collapsed = false;
        var depth = (p.depth || 0) + 1;
        var side = null;
        if (parentId === state.centralId) {
            var mains = childrenOf(state.centralId);
            var r = 0, l = 0;
            for (var i = 0; i < mains.length; i++) (sideOf(mains[i]) === 'L' ? l++ : r++);
            side = (r <= l) ? 'R' : 'L';
        }
        var id = uid();
        state.nodes[id] = {
            id: id, parentId: parentId,
            text: (text != null) ? text : (depth === 1 ? '分支主題' : '子主題'),
            sortOrder: (childrenOf(parentId).length + 1) * 10,
            collapsed: false, side: side, color: null,
            type: 'topic', posX: null, posY: null, structure: null, props: null
        };
        afterMutate();
        select(id);
        return id;
    }

    function addSibling(id, text) {
        if (!node(id)) return null;
        if (node(id).type === 'callout' || node(id).type === 'summary') return null;
        if (id === state.centralId) return addChild(id, text);
        pushUndo();
        var ref = node(id);
        var nid = uid();
        var n = {
            id: nid, parentId: ref.parentId,
            text: (text != null) ? text : ((ref.parentId === state.centralId) ? '分支主題' : '子主題'),
            sortOrder: ref.sortOrder + 5,
            collapsed: false,
            side: (ref.parentId === state.centralId) ? sideOf(ref) : null,
            color: null,
            type: 'topic', posX: null, posY: null, structure: null, props: null
        };
        state.nodes[nid] = n;
        normalizeOrders(ref.parentId);
        afterMutate();
        select(nid);
        return nid;
    }

    /* ---------------- P2：浮動主題 ---------------- */
    function addFloating(worldX, worldY, text) {
        pushUndo();
        var id = uid();
        var n = blankNode(id, null, (text != null) ? text : '浮動主題', 'floating');
        n.posX = worldX;
        n.posY = worldY;
        n.sortOrder = (floatingRoots().length + 1) * 10;
        state.nodes[id] = n;
        state.selectedId = id;
        state.selectedIds = [id];
        afterMutate();
        return id;
    }

    /* 把樹上的節點（連同整個子樹）拆離成浮動主題 */
    function detachToFloating(id, worldX, worldY) {
        var n = node(id);
        if (!n || id === state.centralId || n.type === 'callout' || n.type === 'summary') return;
        if (n.type === 'floating' && !n.parentId) { setFloatingPos(id, worldX, worldY); return; }
        pushUndo();
        var oldParent = n.parentId;
        n.parentId = null;
        n.type = 'floating';
        n.side = null;
        n.posX = worldX;
        n.posY = worldY;
        n.sortOrder = (floatingRoots().length + 1) * 10;
        if (oldParent && state.nodes[oldParent]) normalizeOrders(oldParent);
        state.selectedId = id;
        state.selectedIds = [id];
        afterMutate();
    }

    function setFloatingPos(id, worldX, worldY) {
        var n = node(id);
        if (!n || n.type !== 'floating' || n.parentId) return;
        if (n.posX === worldX && n.posY === worldY) return;
        pushUndo();
        n.posX = worldX;
        n.posY = worldY;
        afterMutate();
    }

    /* ---- 自由拖曳（2026-07 語意修正）：樹上節點拖到空白＝固定在該位置，父子連線不斷 ---- */
    function isPinned(n) {
        return !!(n && n.type === 'topic' && n.parentId &&
                  typeof n.posX === 'number' && typeof n.posY === 'number');
    }

    /* 固定樹上節點於指定世界座標（節點中心） */
    function pinNodeAt(id, worldX, worldY) {
        var n = node(id);
        if (!n || n.type !== 'topic' || !n.parentId || id === state.centralId) return;
        if (n.posX === worldX && n.posY === worldY) return;
        pushUndo();
        n.posX = worldX;
        n.posY = worldY;
        afterMutate();
    }

    /* 取消固定＝回到自動排列位置 */
    function clearNodePos(id) {
        var n = node(id);
        if (!n || n.posX == null) return;
        if (n.type !== 'topic') return;
        pushUndo();
        n.posX = null;
        n.posY = null;
        afterMutate();
    }

    /* 全部恢復自動排列（清除所有 topic 的固定位置，一次 undo） */
    function clearAllPins() {
        var hits = [];
        for (var k in state.nodes) {
            if (isPinned(state.nodes[k])) hits.push(state.nodes[k]);
        }
        if (!hits.length) { toast('目前沒有固定位置的節點'); return; }
        pushUndo();
        for (var i = 0; i < hits.length; i++) {
            hits[i].posX = null;
            hits[i].posY = null;
        }
        afterMutate();
        toast('已恢復 ' + hits.length + ' 個節點的自動排列');
    }

    /* 自動排列：把所有浮動主題依外接框排到中心主題右側直欄（間距 24） */
    function tidyFloating() {
        var fls = floatingRoots();
        if (!fls.length) { toast('目前沒有浮動主題需要整理'); return; }
        var central = node(state.centralId);
        pushUndo();
        var x = central ? ((central.cx - central._ax) + central._bw + 80) : 80;
        var y = central ? (central.cy - central._ay) : 0;
        for (var i = 0; i < fls.length; i++) {
            var f = fls[i];
            var ax = (f._ax != null) ? f._ax : (f.w || 60) / 2;
            var ay = (f._ay != null) ? f._ay : (f.h || 30) / 2;
            var bh = (f._bh != null) ? f._bh : (f.h || 30);
            f.posX = x + ax;
            f.posY = y + ay;
            y += bh + 24;
        }
        afterMutate();
        toast('已整理 ' + fls.length + ' 個浮動主題');
    }

    /* ---------------- P2：標註（callout） ---------------- */
    function addCallout(hostId) {
        var host = node(hostId);
        if (!host || host.type === 'callout') return null;
        pushUndo();
        var id = uid();
        var n = blankNode(id, hostId, '標註', 'callout');
        n.props = { offset: { dx: 0, dy: -((host.h || 30) / 2 + 34) } };
        state.nodes[id] = n;
        state.selectedId = id;
        state.selectedIds = [id];
        afterMutate();
        return id;
    }

    function setCalloutOffset(id, dx, dy) {
        var n = node(id);
        if (!n || n.type !== 'callout') return;
        pushUndo();
        n.props = n.props || {};
        n.props.offset = { dx: dx, dy: dy };
        afterMutate();
    }

    /* ---------------- P4：多選批刪 ---------------- */
    function removeNodes(ids) {
        var valid = [];
        for (var i = 0; i < ids.length; i++) {
            var n0 = node(ids[i]);
            if (n0 && ids[i] !== state.centralId) valid.push(ids[i]);
        }
        if (!valid.length) return;
        pushUndo();
        var dm = {};
        function collect(pid) {
            var kids = childrenOf(pid, true);
            for (var k = 0; k < kids.length; k++) { dm[kids[k].id] = true; collect(kids[k].id); }
        }
        var parents = {};
        for (i = 0; i < valid.length; i++) {
            dm[valid[i]] = true;
            collect(valid[i]);
            var p = node(valid[i]).parentId;
            if (p) parents[p] = true;
        }
        for (var key in dm) delete state.nodes[key];
        pruneRefs(dm);
        for (var pk in parents) if (state.nodes[pk]) normalizeOrders(pk);
        state.selectedId = state.centralId;
        state.selectedIds = state.selectedId ? [state.selectedId] : [];
        afterMutate();
    }

    /* ---------------- P4：外框（Boundary） ---------------- */
    function findBoundary(bid) {
        for (var i = 0; i < state.boundaries.length; i++) {
            if (state.boundaries[i].boundaryId === bid) return state.boundaries[i];
        }
        return null;
    }

    /* addBoundary(memberIds[]) — 任意多選（可跨層級、不連續）。
       仍相容舊呼叫 addBoundary(parentId, fromChildId, toChildId)。 */
    function addBoundary(a, b2, c2) {
        var raw = [], i;
        if (Object.prototype.toString.call(a) === '[object Array]') {
            raw = a.slice();
        } else {
            var fx = fixRange(a, b2, c2);
            if (!fx) { toast('外框需要有效的主題節點'); return null; }
            raw = normalizeMembers({ parentId: a, fromChildId: fx.from, toChildId: fx.to });
        }
        var ids = normalizeMembers({ memberIds: raw });
        if (!ids.length) { toast('請選取要框起來的主題節點'); return null; }

        var key = ids.slice().sort().join(',');
        for (i = 0; i < state.boundaries.length; i++) {
            if (normalizeMembers(state.boundaries[i]).slice().sort().join(',') === key) {
                toast('這些節點已經有外框了');
                return null;
            }
        }
        pushUndo();
        var bid = uid();
        state.boundaries.push({ boundaryId: bid, memberIds: ids, label: null, props: null });
        state.selectedBoundaryId = bid;
        state.selectedId = null;
        state.selectedIds = [];
        state.selectedRelId = null;
        afterMutate();
        return bid;
    }

    function removeBoundary(bid) {
        for (var i = 0; i < state.boundaries.length; i++) {
            if (state.boundaries[i].boundaryId === bid) {
                pushUndo();
                state.boundaries.splice(i, 1);
                if (state.selectedBoundaryId === bid) state.selectedBoundaryId = null;
                afterMutate();
                return true;
            }
        }
        return false;
    }

    function setBoundaryLabel(bid, label) {
        var b = findBoundary(bid);
        if (!b) return;
        var v = (label != null && ('' + label).trim()) ? ('' + label).trim() : null;
        if (v === b.label) return;
        pushUndo();
        b.label = v;
        afterMutate();
    }

    function setBoundaryColor(bid, color) {
        var b = findBoundary(bid);
        if (!b) return;
        pushUndo();
        var pr = safeParseProps(b.props) || {};
        if (color) pr.color = color;
        else delete pr.color;
        b.props = propsToStr(pr);
        afterMutate();
    }

    function selectBoundary(bid) {
        state.selectedBoundaryId = bid;
        state.selectedId = null;
        state.selectedIds = [];
        state.selectedRelId = null;
        render();
    }

    /* ---------------- P4：概要（Summary） ---------------- */
    function addSummary(parentId, fromChildId, toChildId) {
        var fx = fixRange(parentId, fromChildId, toChildId);
        if (!fx) { toast('概要需要同一層的兄弟節點'); return null; }
        var st0 = structureOf(node(fx.from));
        if (st0 !== 'logic-right' && st0 !== 'logic-left') {
            toast('概要目前僅支援水平結構（心智圖／邏輯圖）');
            return null;
        }
        for (var i = 0; i < state.summaries.length; i++) {
            var s = state.summaries[i];
            if (s.parentId === parentId && s.fromChildId === fx.from && s.toChildId === fx.to) {
                toast('這個範圍已經有概要了');
                return null;
            }
        }
        pushUndo();
        var topicId = uid();
        var t = blankNode(topicId, parentId, '概要', 'summary');
        t.structure = st0;   /* 概要子樹固定沿區間方向展開 */
        state.nodes[topicId] = t;
        state.summaries.push({ summaryId: uid(), parentId: parentId, fromChildId: fx.from, toChildId: fx.to, topicId: topicId });
        state.selectedId = topicId;
        state.selectedIds = [topicId];
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        afterMutate();
        return topicId;
    }

    /* ---------------- P5：屬性寫入／主題／連結／備註／表格 ---------------- */
    function mergeProps(pr, patch) {
        for (var k in patch) {
            var v = patch[k];
            if (v === null) { delete pr[k]; continue; }
            if (v && typeof v === 'object' && !Array.isArray(v) &&
                pr[k] && typeof pr[k] === 'object' && !Array.isArray(pr[k])) {
                for (var k2 in v) {
                    if (v[k2] === null) delete pr[k][k2];
                    else pr[k][k2] = v[k2];
                }
                var hasSub = false;
                for (var kk in pr[k]) { hasSub = true; break; }
                if (!hasSub) delete pr[k];
            } else {
                pr[k] = v;
            }
        }
        return pr;
    }

    /* 寫入節點屬性：淺合併、null 刪鍵；多選一次 pushUndo */
    function setProps(ids, patch) {
        var list = Array.isArray(ids) ? ids : [ids];
        var targets = [];
        for (var i = 0; i < list.length; i++) {
            var n0 = node(list[i]);
            if (n0 && n0.type !== 'callout') targets.push(n0);
        }
        if (!targets.length || !patch) return;
        pushUndo();
        for (i = 0; i < targets.length; i++) {
            var n = targets[i];
            var pr = n.props || {};
            mergeProps(pr, patch);
            var has = false;
            for (var hk in pr) { has = true; break; }
            n.props = has ? pr : null;
        }
        afterMutate();
        refreshStylePanel();
    }

    function setTheme(name) {
        var v = (name === 'dark') ? 'dark' : 'classic';
        if (v === state.mapTheme) return;
        pushUndo();
        state.mapTheme = v;
        applyTheme();
        afterMutate();
        refreshStylePanel();
    }

    /* ---- 超連結 ---- */
    function followLink(id) {
        var n = node(id);
        var lk = n && n.props && n.props.link;
        if (!lk || !lk.value) return;
        if (lk.type === 'topic') {
            var t = node(lk.value);
            if (!t) { toast('連結的主題已不存在', true); return; }
            var chain = [], cur = t, guard = 0;
            while (cur && cur.parentId && guard++ < 10000) {
                cur = node(cur.parentId);
                if (cur && cur.collapsed) chain.push(cur);
            }
            if (chain.length) {
                pushUndo();
                for (var i = 0; i < chain.length; i++) chain[i].collapsed = false;
                afterMutate();
            }
            select(lk.value);
            flashNode(lk.value);
        } else {
            var url = '' + lk.value;
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            try { window.open(url, '_blank', 'noopener'); } catch (e) { }
        }
    }

    function flashNode(id) {
        var n = node(id);
        if (!n || n.cx == null || !els.overlayLayer) return;
        els.overlayLayer.appendChild(mk('rect', {
            x: r2(n.cx - n.w / 2 - 8), y: r2(n.cy - n.h / 2 - 8),
            width: r2(n.w + 16), height: r2(n.h + 16),
            rx: (n._st ? n._st.radius : 8) + 4,
            fill: 'none', stroke: SEL_COLOR, 'stroke-width': 3, opacity: 0.9
        }));
        setTimeout(function () { render(); }, 500);
    }

    function openLinkModal(id) {
        var n = node(id);
        if (!n || !els.linkModal) return;
        state.linkFor = id;
        var lk = (n.props && n.props.link) || null;
        var typ = (lk && lk.type === 'topic') ? 'topic' : 'url';
        els.lmTypeUrl.checked = (typ === 'url');
        els.lmTypeTopic.checked = (typ === 'topic');
        els.lmValue.value = (lk && lk.type === 'url') ? lk.value : '';
        var tgt = (lk && lk.type === 'topic') ? node(lk.value) : null;
        els.lmTopicName.textContent = tgt ? ('目前目標：' + (tgt.text || '（未命名）')) : '尚未選擇目標主題';
        updateLinkModalMode();
        els.linkModal.classList.remove('hidden');
        if (typ === 'url') { els.lmValue.focus(); els.lmValue.select(); }
    }
    function updateLinkModalMode() {
        if (!els.lmUrlRow) return;
        var isUrl = els.lmTypeUrl.checked;
        els.lmUrlRow.style.display = isUrl ? '' : 'none';
        els.lmTopicRow.style.display = isUrl ? 'none' : '';
    }
    function closeLinkModal() {
        if (els.linkModal) els.linkModal.classList.add('hidden');
        state.linkFor = null;
    }
    function commitLinkModal() {
        var id = state.linkFor;
        if (!id) { closeLinkModal(); return; }
        if (els.lmTypeUrl.checked) {
            var v = els.lmValue.value.trim();
            if (!v) { toast('請輸入網址'); return; }
            setProps(id, { link: { type: 'url', value: v } });
            closeLinkModal();
        } else {
            /* 主題模式：關窗進入點選 */
            closeLinkModal();
            state.picking = { forId: id };
            if (els.svg) els.svg.style.cursor = 'crosshair';
            toast('點擊要連到的主題，Esc 取消');
        }
    }
    function cancelPicking() {
        state.picking = null;
        if (els.svg) els.svg.style.cursor = '';
    }

    /* ---- 備註 ---- */
    function openNoteModal(id) {
        var n = node(id);
        if (!n || !els.noteModal) return;
        state.noteFor = id;
        els.nmText.value = (n.props && n.props.note) || '';
        els.noteModal.classList.remove('hidden');
        els.nmText.focus();
    }
    function closeNoteModal() {
        if (els.noteModal) els.noteModal.classList.add('hidden');
        state.noteFor = null;
    }
    function commitNoteModal() {
        var id = state.noteFor;
        if (id) {
            var v = els.nmText.value.trim();
            setProps(id, { note: v || null });
        }
        closeNoteModal();
    }

    /* ---------------- P8：AI 生成 ---------------- */

    /* 解析容錯：去 ``` 圍欄 → 取第一個 [ 或 { 到配對結尾 → JSON.parse；失敗回 null */
    function parseAiJson(text) {
        if (!text) return null;
        var s = ('' + text).trim();
        s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
        var start = -1, openCh = null, closeCh = null;
        for (var i = 0; i < s.length; i++) {
            if (s[i] === '[' || s[i] === '{') { start = i; openCh = s[i]; closeCh = (s[i] === '[') ? ']' : '}'; break; }
        }
        if (start < 0) return null;
        var depth = 0, inStr = false, esc = false, end = -1;
        for (i = start; i < s.length; i++) {
            var c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === openCh) depth++;
            else if (c === closeCh) { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) return null;
        try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
    }

    /* 根 > … > 本節點 的路徑字串（給 AI 當上下文） */
    function topicPath(id) {
        var chain = [], cur = node(id), guard = 0;
        while (cur && guard++ < 10000) { chain.unshift(cur.text || '（未命名）'); cur = cur.parentId ? node(cur.parentId) : null; }
        return chain.join(' > ');
    }

    function aiChat(messages) {
        return api('ai', { body: { messages: messages } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || 'AI 呼叫失敗');
            return res.content;
        });
    }

    /* 為單一節點產生 n 個新子主題 */
    function aiExpand(id, n, extra) {
        var host = node(id);
        if (!host) return Promise.reject(new Error('節點不存在'));
        var existing = childrenOf(id).map(function (c) { return c.text; });
        var sys = '你是心智圖助手。只輸出一個 JSON 字串陣列，絕對不要輸出任何其他文字、說明或 markdown 圍欄。';
        var usr = '主題路徑：' + topicPath(id) + '\n' +
                  '既有子主題：' + (existing.length ? existing.join('、') : '（無）') + '\n' +
                  '補充需求：' + (extra || '（無）') + '\n' +
                  '請提出 ' + n + ' 個新的子主題，繁體中文，每個不超過 12 字，不得與既有重複。';
        return aiChat([{ role: 'system', content: sys }, { role: 'user', content: usr }]).then(function (text) {
            var arr = parseAiJson(text);
            if (!Array.isArray(arr) || !arr.length) {
                var err = new Error('模型未輸出合法 JSON，請重試');
                err.raw = ('' + text).slice(0, 300);
                throw err;
            }
            pushUndo();
            var added = 0;
            for (var i = 0; i < arr.length && i < 30; i++) {
                var t = ('' + arr[i]).trim();
                if (!t) continue;
                var nid = uid();
                var side = null;
                if (id === state.centralId) {
                    var rC = 0, lC = 0, sibs0 = childrenOf(id);
                    for (var k = 0; k < sibs0.length; k++) (sibs0[k].side === 'L' ? lC++ : rC++);
                    side = (rC <= lC) ? 'R' : 'L';
                }
                var nn = blankNode(nid, id, t.slice(0, 60), 'topic');
                nn.side = side;
                nn.sortOrder = (childrenOf(id).length + 1) * 10;
                state.nodes[nid] = nn;
                added++;
            }
            if (!added) { state.undoStack.pop(); throw new Error('模型未輸出合法 JSON，請重試'); }
            afterMutate();
            toast('已加入 ' + added + ' 個子主題');
            return added;
        });
    }

    /* 遞迴建樹：{"text":"...","children":[...]}，深度≤3、每層≤6，掛在新浮動主題（空圖則掛 central） */
    function buildAiTree(parentId, spec, depth) {
        if (!spec || depth > 3) return 0;
        var count = 0;
        var kids = Array.isArray(spec.children) ? spec.children.slice(0, 6) : [];
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            var text = (k && k.text) ? ('' + k.text).trim().slice(0, 60) : '';
            if (!text) continue;
            var nid = uid();
            var side = null;
            if (parentId === state.centralId) {
                var rC = 0, lC = 0, sibs0 = childrenOf(parentId);
                for (var j = 0; j < sibs0.length; j++) (sibs0[j].side === 'L' ? lC++ : rC++);
                side = (rC <= lC) ? 'R' : 'L';
            }
            var nn = blankNode(nid, parentId, text, 'topic');
            nn.side = side;
            nn.sortOrder = (childrenOf(parentId).length + 1) * 10;
            state.nodes[nid] = nn;
            count++;
            count += buildAiTree(nid, k, depth + 1);
        }
        return count;
    }

    function aiGenerateMap(topic) {
        var sys = '你是心智圖助手。只輸出一個 JSON 物件，格式為 {"text":"主題","children":[{"text":"子主題","children":[...]}]}，' +
                  '絕對不要輸出任何其他文字、說明或 markdown 圍欄。深度不超過 3 層，每層不超過 6 個子項，繁體中文，每個主題不超過 12 字。';
        var usr = '請針對主題「' + topic + '」產生一份心智圖結構。';
        return aiChat([{ role: 'system', content: sys }, { role: 'user', content: usr }]).then(function (text) {
            var obj = parseAiJson(text);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                var err = new Error('模型未輸出合法 JSON，請重試');
                err.raw = ('' + text).slice(0, 300);
                throw err;
            }
            pushUndo();
            var rootText = (obj.text ? ('' + obj.text).trim() : topic).slice(0, 60) || topic;
            var rootId, addedCount;
            if (!node(state.centralId)) {
                rootId = uid();
                state.nodes[rootId] = blankNode(rootId, null, rootText, 'central');
                state.centralId = rootId;
                addedCount = 1 + buildAiTree(rootId, obj, 1);
            } else {
                rootId = uid();
                var fr = blankNode(rootId, null, rootText, 'floating');
                var fls = floatingRoots();
                fr.posX = 260 + fls.length * 48;
                fr.posY = 200 + fls.length * 48;
                fr.sortOrder = (fls.length + 1) * 10;
                state.nodes[rootId] = fr;
                addedCount = 1 + buildAiTree(rootId, obj, 1);
            }
            afterMutate();
            fitView();
            toast('已生成心智圖（' + addedCount + ' 個主題）');
            return addedCount;
        });
    }

    /* ---- 視窗：AI 產生子主題／AI 生成整張圖 共用 aiModal ---- */
    var lastAiErrorText = '';

    function openErrModal(title, fullText) {
        if (!els.errModal) return;
        lastAiErrorText = fullText;
        els.errTitle.textContent = title || '錯誤訊息';
        els.errText.value = fullText;
        els.errModal.classList.remove('hidden');
    }

    function closeErrModal() {
        if (els.errModal) els.errModal.classList.add('hidden');
    }

    function copyErrText() {
        var done = function () { toast('已複製到剪貼簿'); };
        var fail = function () { els.errText.focus(); els.errText.select(); toast('請按 Ctrl+C 複製（已為你全選）', true); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(lastAiErrorText).then(done).catch(fail);
        } else {
            fail();
        }
    }

    function setAiBusy(busy, msg) {
        if (!els.aiModal) return;
        var box = els.aiModal.querySelector('.box');
        if (box) box.classList.toggle('busy', busy);
        var full = msg || '';
        /* 短訊息（提示、進度）用 hint 顯示；長訊息（錯誤內容）直接放進唯讀 textarea，自帶捲軸、可複製 */
        var isLong = (!busy && full.length > 40);
        if (els.aiStatus) {
            els.aiStatus.textContent = isLong ? '' : full;
            els.aiStatus.classList.toggle('spin', !!busy);
        }
        if (els.aiErrRow && els.aiErrBtnRow && els.aiErrBox) {
            els.aiErrRow.style.display = isLong ? 'flex' : 'none';
            els.aiErrBtnRow.style.display = isLong ? 'flex' : 'none';
            els.aiErrBox.value = isLong ? full : '';
        }
    }

    function openAiExpandModal(id) {
        if (!els.aiModal) return;
        state.ai = { mode: 'expand', forId: id };
        els.aiTitle.textContent = 'AI 產生子主題';
        els.aiCountRow.style.display = '';
        els.aiExtra.placeholder = '補充需求（選填）…';
        els.aiExtra.value = '';
        setAiBusy(false, '');
        els.aiModal.classList.remove('hidden');
        els.aiExtra.focus();
    }

    /* 通用單欄輸入（flow/slides/draw/search 共用 aiModal） */
    function openAiPromptModal(mode, title, placeholder) {
        if (!els.aiModal) return;
        state.ai = { mode: mode };
        els.aiTitle.textContent = title;
        els.aiCountRow.style.display = 'none';
        els.aiExtra.placeholder = placeholder;
        els.aiExtra.value = '';
        setAiBusy(false, '');
        els.aiModal.classList.remove('hidden');
        els.aiExtra.focus();
    }

    function openAiMapModal() {
        if (!els.aiModal) return;
        state.ai = { mode: 'map' };
        els.aiTitle.textContent = 'AI 生成心智圖';
        els.aiCountRow.style.display = 'none';
        els.aiExtra.placeholder = '輸入主題，例如：新產品上市計畫…';
        els.aiExtra.value = '';
        setAiBusy(false, '');
        els.aiModal.classList.remove('hidden');
        els.aiExtra.focus();
    }

    function closeAiModal() {
        if (els.aiModal) els.aiModal.classList.add('hidden');
        state.ai = null;
        setAiBusy(false, '');
    }

    function commitAiModal() {
        var st = state.ai;
        if (!st) return;
        if (st.mode === 'expand') {
            var n = parseInt(els.aiCount.value, 10) || 5;
            var extra = els.aiExtra.value.trim();
            setAiBusy(true, '產生中…');
            aiExpand(st.forId, n, extra).then(function () {
                closeAiModal();
            }).catch(function (e) {
                setAiBusy(false, e.message + (e.raw ? '\n\n模型原始輸出（前 300 字）：\n' + e.raw : ''));
            });
        } else {
            var topic = els.aiExtra.value.trim();
            if (!topic) { setAiBusy(false, '請輸入內容'); return; }
            var fn = { map: aiGenerateMap, flow: aiFlowchart, slides: aiSlides, draw: aiDraw, search: aiWebSearch }[st.mode];
            if (!fn) return;
            setAiBusy(true, '產生中…');
            fn(topic).then(function () {
                closeAiModal();
            }).catch(function (e) {
                setAiBusy(false, e.message + (e.raw ? '\n\n模型原始輸出（前 300 字）：\n' + e.raw : ''));
            });
        }
    }


    /* ---------------- P8+：AI 選單擴充（AI 助手／AI 試卷） ---------------- */

    /* 目前心智圖的縮排大綱（給 AI 助手／試卷當上下文，最多 4000 字） */
    function mapOutline() {
        var lines = [];
        function walk(id, depth) {
            var n = node(id);
            if (!n) return;
            lines.push(new Array(depth + 1).join('  ') + '- ' + (n.text || '（未命名）'));
            var kids = childrenOf(id);
            for (var i = 0; i < kids.length; i++) walk(kids[i].id, depth + 1);
        }
        if (node(state.centralId)) walk(state.centralId, 0);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) { lines.push('- （浮動）'); walk(fls[fi].id, 1); }
        var s = lines.join('\n');
        return s.length > 4000 ? s.slice(0, 4000) + '\n…（內容過長已截斷）' : s;
    }

    /* ---- AI 助手：右側聊天面板 ---- */
    var aiChatHistory = [];

    function aiChatAppend(role, text) {
        if (!els.aiChatMsgs) return null;
        var d = document.createElement('div');
        d.className = 'ai-msg ' + role;
        d.textContent = text;
        els.aiChatMsgs.appendChild(d);
        els.aiChatMsgs.scrollTop = els.aiChatMsgs.scrollHeight;
        return d;
    }

    function toggleAiChat(open) {
        if (!els.aiChatPanel) return;
        var willOpen = (open !== undefined) ? open : !els.aiChatPanel.classList.contains('open');
        els.aiChatPanel.classList.toggle('open', willOpen);
        if (willOpen) {
            if (!aiChatHistory.length && !els.aiChatMsgs.childNodes.length)
                aiChatAppend('bot', '你好！我是 AI 助手，可以依目前這張心智圖的內容回答問題，也可以聊聊怎麼補強它。');
            els.aiChatInput.focus();
        }
    }

    function aiChatSubmit() {
        var q = (els.aiChatInput.value || '').trim();
        if (!q || els.aiChatSend.disabled) return;
        els.aiChatInput.value = '';
        aiChatAppend('user', q);
        aiChatHistory.push({ role: 'user', content: q });
        if (aiChatHistory.length > 12) aiChatHistory = aiChatHistory.slice(-12);
        els.aiChatSend.disabled = true;
        var thinking = aiChatAppend('bot', '思考中…');
        var sys = '你是心智圖軟體內建的 AI 助手，請用繁體中文、口語但精確地回答。' +
                  '以下是使用者目前這張心智圖的大綱，回答時請優先參考它：\n' + mapOutline();
        aiChat([{ role: 'system', content: sys }].concat(aiChatHistory)).then(function (text) {
            thinking.textContent = text;
            aiChatHistory.push({ role: 'assistant', content: text });
            els.aiChatMsgs.scrollTop = els.aiChatMsgs.scrollHeight;
        }).catch(function (e) {
            thinking.className = 'ai-msg err';
            thinking.textContent = e.message;
        }).then(function () {
            els.aiChatSend.disabled = false;
            els.aiChatInput.focus();
        });
    }

    /* ---- AI 試卷：依目前心智圖出題，另開可列印視窗 ---- */
    function escHtml(s) {
        return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function aiQuiz() {
        var outline = mapOutline();
        if (!outline.trim()) { toast('目前心智圖沒有內容，無法出題', true); return; }
        toast('AI 出題中，請稍候…');
        var sys = '你是出題助手。只輸出一個 JSON 物件，絕對不要輸出任何其他文字、說明或 markdown 圍欄。格式：' +
                  '{"title":"試卷標題","questions":[{"q":"題目","options":["A選項","B選項","C選項","D選項"],"answer":0,"explain":"簡短解析"}]}，' +
                  'answer 為正確選項的索引（0~3）。共 10 題，繁體中文，題目須根據提供的大綱內容。';
        var usr = '請根據以下心智圖大綱出一份選擇題試卷：\n' + outline;
        aiChat([{ role: 'system', content: sys }, { role: 'user', content: usr }]).then(function (text) {
            var obj = parseAiJson(text);
            var qs = obj && obj.questions;
            if (!Array.isArray(qs) || !qs.length) { toast('模型未輸出合法 JSON，請重試', true); return; }
            var title = escHtml(obj.title || ((node(state.centralId) || {}).text || '') + ' 試卷');
            var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
            var body = '', ans = '';
            for (var i = 0; i < qs.length; i++) {
                var it = qs[i] || {};
                var ops = Array.isArray(it.options) ? it.options : [];
                body += '<div class="q"><div class="qt">' + (i + 1) + '. ' + escHtml(it.q || '') + '</div><ol type="A">';
                for (var j = 0; j < ops.length; j++) body += '<li>' + escHtml(ops[j]) + '</li>';
                body += '</ol></div>';
                var aIdx = (typeof it.answer === 'number') ? it.answer : -1;
                ans += '<div class="q"><b>' + (i + 1) + '.</b> ' + (LETTERS[aIdx] || '？') +
                       (it.explain ? '　<span class="ex">' + escHtml(it.explain) + '</span>' : '') + '</div>';
            }
            var html = '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + title + '</title><style>' +
                'body{font:15px/1.7 "Microsoft JhengHei",system-ui,sans-serif;color:#222;max-width:760px;margin:24px auto;padding:0 16px;}' +
                'h1{font-size:20px;text-align:center;}h2{font-size:16px;border-top:1px dashed #999;padding-top:16px;margin-top:28px;}' +
                '.q{margin:12px 0;}.qt{font-weight:600;}ol{margin:4px 0 0 8px;}.ex{color:#555;font-size:13.5px;}' +
                '.bar{text-align:center;margin:12px 0;}button{font:inherit;padding:6px 16px;cursor:pointer;}' +
                '@media print{.bar{display:none;}}' +
                '</style></head><body><div class="bar"><button onclick="print()">🖨️ 列印</button></div>' +
                '<h1>' + title + '</h1>' + body + '<h2>解答與解析</h2>' + ans + '</body></html>';
            var w = window.open('', '_blank');
            if (!w) { toast('瀏覽器阻擋了彈出視窗，請允許後重試', true); return; }
            w.document.write(html);
            w.document.close();
            toast('試卷已產生（共 ' + qs.length + ' 題）');
        }).catch(function (e) {
            toast(e.message, true);
        });
    }

    /* ---- AI 流程圖：JSON {nodes,edges} → 分層 SVG，另開視窗 ---- */
    function openHtmlWindow(html, failMsg) {
        var w = window.open('', '_blank');
        if (!w) { throw new Error(failMsg || '瀏覽器阻擋了彈出視窗，請允許後重試'); }
        w.document.write(html);
        w.document.close();
        return w;
    }

    function flowShapePath(type, x, y, w, h) {
        if (type === 'decision') {
            var cx = x + w / 2, cy = y + h / 2;
            return '<polygon points="' + cx + ',' + y + ' ' + (x + w) + ',' + cy + ' ' + cx + ',' + (y + h) + ' ' + x + ',' + cy + '" ';
        }
        if (type === 'io') {
            var k = 14;
            return '<polygon points="' + (x + k) + ',' + y + ' ' + (x + w) + ',' + y + ' ' + (x + w - k) + ',' + (y + h) + ' ' + x + ',' + (y + h) + '" ';
        }
        var rx = (type === 'start' || type === 'end') ? h / 2 : 8;
        return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + rx + '" ';
    }

    function aiFlowchart(topic) {
        var sys = '你是流程圖助手。只輸出一個 JSON 物件，絕對不要輸出任何其他文字或 markdown 圍欄。格式：' +
            '{"title":"標題","nodes":[{"id":"n1","text":"文字","type":"start|process|decision|io|end"}],' +
            '"edges":[{"from":"n1","to":"n2","label":"是/否等，可省略"}]}。' +
            '節點 6~14 個，繁體中文，每個文字不超過 14 字，必須恰有一個 start，至少一個 end，decision 需有帶 label 的分支。';
        var usr = '請針對「' + topic + '」設計一張流程圖。';
        return aiChat([{ role: 'system', content: sys }, { role: 'user', content: usr }]).then(function (text) {
            var obj = parseAiJson(text);
            var nodes = obj && obj.nodes, edges = (obj && obj.edges) || [];
            if (!Array.isArray(nodes) || !nodes.length) {
                var err = new Error('模型未輸出合法 JSON，請重試'); err.raw = ('' + text).slice(0, 300); throw err;
            }
            /* 簡單可靠的排版：節點由上而下單欄堆疊（流程圖以線性為主）。
               連線依「edges 指定的順序關係」畫；若形成分支/回流，額外用右側折線標示，
               但一律限制在畫布範圍內，杜絕失控長線。 */
            var byId = {};
            nodes.forEach(function (n) { byId[n.id] = n; });
            edges = edges.filter(function (e) { return e && byId[e.from] && byId[e.to] && e.from !== e.to; });

            /* 依主流程排序：從 start 開始沿「第一條出邊」走，串成主鏈；其餘節點接在後面 */
            var firstOut = {};
            edges.forEach(function (e) { if (firstOut[e.from] === undefined) firstOut[e.from] = e.to; });
            var order = [], seen = {};
            var startNode = null;
            for (var s = 0; s < nodes.length; s++) { if ((nodes[s].type || '') === 'start') { startNode = nodes[s].id; break; } }
            if (!startNode) startNode = nodes[0].id;
            var cur = startNode, hop = 0;
            while (cur && !seen[cur] && hop++ < nodes.length + 2) { seen[cur] = 1; order.push(cur); cur = firstOut[cur]; }
            nodes.forEach(function (n) { if (!seen[n.id]) { seen[n.id] = 1; order.push(n.id); } });

            var NW = 190, NH = 54, GY = 46;
            var idxOf = {};
            order.forEach(function (id, k) { idxOf[id] = k; });
            var svgW = NW + 220;                 /* 主欄 + 右側回流通道 */
            var svgH = order.length * (NH + GY) + GY;
            var colX = (svgW - NW) / 2 - 40;     /* 主欄稍偏左，右側留給折線 */
            var pos = {};
            order.forEach(function (id, k) { pos[id] = { x: colX, y: GY + k * (NH + GY) }; });

            var COLORS = { start: '#DFF5E1', end: '#FDE2E1', decision: '#FFF3CD', io: '#E3ECFF', process: '#F0F2F6' };
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" font-family="Microsoft JhengHei,system-ui,sans-serif" font-size="13">' +
                '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
                '<path d="M0,0 L10,5 L0,10 z" fill="#556075"/></marker></defs>';

            edges.forEach(function (e) {
                var a = pos[e.from], b = pos[e.to];
                if (!a || !b) return;
                var ai = idxOf[e.from], bi = idxOf[e.to];
                var cxA = a.x + NW / 2, cxB = b.x + NW / 2;
                if (bi === ai + 1) {
                    /* 相鄰：直接垂直連線 */
                    svg += '<path d="M' + cxA + ',' + (a.y + NH) + ' V' + b.y + '" fill="none" stroke="#556075" stroke-width="1.6" marker-end="url(#ar)"/>';
                    if (e.label) svg += '<text x="' + (cxA + 8) + '" y="' + (a.y + NH + GY / 2) + '" fill="#8A9A8B" font-size="12">' + escHtml(e.label) + '</text>';
                } else {
                    /* 跨越或回流：走右側通道折線（限制在畫布內） */
                    var chX = a.x + NW + 40 + (Math.abs(bi - ai) % 3) * 18;
                    if (chX > svgW - 12) chX = svgW - 12;
                    var yA = a.y + NH / 2, yB = b.y + NH / 2;
                    svg += '<path d="M' + (a.x + NW) + ',' + yA + ' H' + chX + ' V' + yB + ' H' + (b.x + NW) + '" fill="none" stroke="#9AA4B2" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#ar)"/>';
                    if (e.label) svg += '<text x="' + (chX - 4) + '" y="' + ((yA + yB) / 2) + '" text-anchor="end" fill="#8A9A8B" font-size="12">' + escHtml(e.label) + '</text>';
                }
            });
            order.forEach(function (id) {
                var n = byId[id], p = pos[id]; if (!n || !p) return;
                var t = n.type || 'process';
                svg += flowShapePath(t, p.x, p.y, NW, NH) + ' fill="' + (COLORS[t] || COLORS.process) + '" stroke="#556075" stroke-width="1.4"/>';
                var txt = escHtml(('' + (n.text || '')).slice(0, 22));
                svg += '<text x="' + (p.x + NW / 2) + '" y="' + (p.y + NH / 2 + 4) + '" text-anchor="middle" fill="#333A45">' + txt + '</text>';
            });
            svg += '</svg>';
            var title = escHtml((obj.title || topic) + '');
            openHtmlWindow('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + title + '</title><style>' +
                'body{font-family:"Microsoft JhengHei",system-ui,sans-serif;text-align:center;margin:20px;color:#222;}' +
                '.bar{margin-bottom:12px;}button{font:inherit;padding:6px 16px;cursor:pointer;margin:0 4px;}' +
                'svg{max-width:100%;height:auto;border:1px solid #e2e5ec;border-radius:10px;}' +
                '@media print{.bar{display:none;}svg{border:0;}}</style></head><body>' +
                '<div class="bar"><button onclick="print()">🖨️ 列印</button><button onclick="dl()">⬇️ 下載 SVG</button></div>' +
                '<h2>' + title + '</h2>' + svg +
                '<scr' + 'ipt>function dl(){var s=document.querySelector("svg").outerHTML;' +
                'var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([s],{type:"image/svg+xml"}));' +
                'a.download="flowchart.svg";a.click();}</scr' + 'ipt></body></html>');
            toast('流程圖已產生（' + nodes.length + ' 個節點）');
        });
    }

    /* ---- AI 簡報：slides JSON → 可翻頁、可列印的播放視窗 ---- */
    function aiSlides(topic) {
        var outline = mapOutline();
        var sys = '你是簡報助手。只輸出一個 JSON 物件，絕對不要輸出任何其他文字或 markdown 圍欄。格式：' +
            '{"title":"簡報標題","slides":[{"title":"頁標題","bullets":["要點一","要點二"]}]}。' +
            '6~10 頁，繁體中文，每頁 3~5 個要點，每個要點不超過 30 字。';
        var usr = '請針對「' + topic + '」製作簡報。' + (outline.trim() ? '\n可參考目前心智圖大綱：\n' + outline : '');
        return aiChat([{ role: 'system', content: sys }, { role: 'user', content: usr }]).then(function (text) {
            var obj = parseAiJson(text);
            var slides = obj && obj.slides;
            if (!Array.isArray(slides) || !slides.length) {
                var err = new Error('模型未輸出合法 JSON，請重試'); err.raw = ('' + text).slice(0, 300); throw err;
            }
            var title = escHtml(obj.title || topic);
            var secs = '<section class="slide cover"><h1>' + title + '</h1><p class="sub">AI 產生的簡報草稿</p></section>';
            slides.forEach(function (s) {
                var bl = Array.isArray(s.bullets) ? s.bullets : [];
                secs += '<section class="slide"><h2>' + escHtml(s.title || '') + '</h2><ul>' +
                    bl.map(function (b) { return '<li>' + escHtml(b) + '</li>'; }).join('') + '</ul></section>';
            });
            openHtmlWindow('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + title + '</title><style>' +
                'body{margin:0;font-family:"Microsoft JhengHei",system-ui,sans-serif;background:#1d232e;color:#333A45;}' +
                '.slide{box-sizing:border-box;width:960px;height:540px;margin:24px auto;background:#fff;border-radius:14px;' +
                'padding:56px 64px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:none;flex-direction:column;}' +
                '.slide.on{display:flex;}' +
                '.cover{justify-content:center;text-align:center;background:linear-gradient(135deg,#3D8AF7,#7B5CF0);color:#fff;}' +
                '.cover .sub{opacity:.85;}h1{font-size:44px;margin:0 0 12px;}h2{font-size:30px;margin:0 0 20px;color:#2A3140;}' +
                'ul{font-size:22px;line-height:1.9;margin:0;padding-left:28px;}' +
                '.bar{position:fixed;left:0;right:0;bottom:14px;text-align:center;color:#aab;}' +
                '.bar button{font:inherit;padding:6px 14px;margin:0 4px;cursor:pointer;border-radius:8px;border:0;}' +
                '@media print{body{background:#fff;}.bar{display:none;}.slide{display:flex;page-break-after:always;box-shadow:none;margin:0 auto;border:1px solid #ddd;}}' +
                '</style></head><body>' + secs +
                '<div class="bar"><button onclick="go(-1)">◀ 上一頁</button><span id="pg"></span>' +
                '<button onclick="go(1)">下一頁 ▶</button><button onclick="print()">🖨️ 列印</button></div>' +
                '<scr' + 'ipt>var i=0,ss=document.querySelectorAll(".slide");function sh(){ss.forEach(function(s,k){s.classList.toggle("on",k===i);});' +
                'document.getElementById("pg").textContent=" "+(i+1)+" / "+ss.length+" ";}' +
                'function go(d){i=Math.min(ss.length-1,Math.max(0,i+d));sh();}' +
                'document.addEventListener("keydown",function(e){if(e.key==="ArrowRight"||e.key===" ")go(1);if(e.key==="ArrowLeft")go(-1);});sh();' +
                '</scr' + 'ipt></body></html>');
            toast('簡報已產生（' + (slides.length + 1) + ' 頁）');
        });
    }

    /* ---- AI 繪圖：後端 aiimg → 圖片視窗（可下載） ---- */
    function aiDraw(prompt) {
        return api('aiimg', { body: { prompt: prompt } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || 'AI 繪圖失敗');
            var src = 'data:' + (res.mime || 'image/png') + ';base64,' + res.data;
            openHtmlWindow('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>AI 繪圖</title><style>' +
                'body{margin:20px;text-align:center;font-family:"Microsoft JhengHei",system-ui,sans-serif;background:#1d232e;color:#eee;}' +
                'img{max-width:92vw;max-height:78vh;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);}' +
                'a{color:#8db9ff;} .p{color:#aab;font-size:13px;max-width:720px;margin:10px auto;}</style></head><body>' +
                '<img src="' + src + '" alt="AI 繪圖結果"/><div class="p">' + escHtml(prompt) + '</div>' +
                '<p><a href="' + src + '" download="ai-image.png">⬇️ 下載圖片</a></p></body></html>');
            toast('圖片已產生');
        });
    }

    /* ---- 聯網搜索：後端 aisearch → 顯示在 AI 助手面板（含來源連結） ---- */
    function aiWebSearch(query) {
        return api('aisearch', { body: { query: query } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '聯網搜索失敗');
            toggleAiChat(true);
            aiChatAppend('user', '🌐 ' + query);
            var d = aiChatAppend('bot', res.content || '');
            var srcs = res.sources || [];
            if (srcs.length && d) {
                var box = document.createElement('div');
                box.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px dashed #c8ccd6;font-size:12px;';
                box.appendChild(document.createTextNode('來源：'));
                for (var i = 0; i < srcs.length && i < 6; i++) {
                    var aEl = document.createElement('a');
                    aEl.href = srcs[i].url; aEl.target = '_blank'; aEl.rel = 'noopener';
                    aEl.textContent = '[' + (i + 1) + '] ' + (srcs[i].title || srcs[i].url);
                    aEl.style.cssText = 'display:block;color:#3D8AF7;text-decoration:none;margin:2px 0;word-break:break-all;';
                    box.appendChild(aEl);
                }
                d.appendChild(box);
                els.aiChatMsgs.scrollTop = els.aiChatMsgs.scrollHeight;
            }
            aiChatHistory.push({ role: 'user', content: query });
            aiChatHistory.push({ role: 'assistant', content: (res.content || '').slice(0, 1500) });
        });
    }

    /* ---- AI 設定視窗 ---- */
    function openAiCfgModal() {
        if (!els.aiCfgModal) return;
        els.cfgStatus.textContent = '讀取中…';
        els.aiCfgModal.classList.remove('hidden');
        api('getaiconfig', {}).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '讀取設定失敗');
            els.cfgKey.value = '';
            els.cfgKeyHint.textContent = res.hasKey ? ('目前金鑰：' + (res.keyMasked || '（已設定）')) : '尚未設定金鑰';
            els.cfgModel.value = res.model || '';
            els.cfgImageModel.value = res.imageModel || '';
            els.cfgSearchModel.value = res.searchModel || '';
            els.cfgEndpoint.value = res.endpoint || '';
            els.cfgStatus.textContent = '';
        }).catch(function (e) { els.cfgStatus.textContent = e.message; });
    }

    function saveAiCfg() {
        els.cfgStatus.textContent = '儲存中…';
        api('setaiconfig', {
            body: {
                key: els.cfgKey.value.trim(),
                model: els.cfgModel.value.trim(),
                imageModel: els.cfgImageModel.value.trim(),
                searchModel: els.cfgSearchModel.value.trim(),
                endpoint: els.cfgEndpoint.value.trim()
            }
        }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '儲存失敗');
            els.aiCfgModal.classList.add('hidden');
            toast('AI 設定已儲存');
        }).catch(function (e) { els.cfgStatus.textContent = e.message; });
    }

    function toggleAiMenu(open) {
        if (!els.aiMenu) return;
        var willOpen = (open !== undefined) ? open : els.aiMenu.classList.contains('hidden');
        if (willOpen && els.btnAiGen) {
            var r = els.btnAiGen.getBoundingClientRect();
            els.aiMenu.style.top = (r.bottom + 6) + 'px';
            els.aiMenu.style.left = '';
            els.aiMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        }
        els.aiMenu.classList.toggle('hidden', !willOpen);
    }

    function onAiMenuClick(e) {
        var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!btn) return;
        toggleAiMenu(false);
        var act = btn.getAttribute('data-act');
        if (act === 'map') openAiMapModal();
        else if (act === 'expand') {
            if (!state.selectedId || !node(state.selectedId)) { toast('請先選取一個節點', true); return; }
            openAiExpandModal(state.selectedId);
        }
        else if (act === 'quiz') aiQuiz();
        else if (act === 'flow') openAiPromptModal('flow', 'AI 流程圖', '輸入主題，例如：請假申請流程…');
        else if (act === 'slides') openAiPromptModal('slides', 'AI 簡報', '輸入主題（會參考目前心智圖）…');
        else if (act === 'draw') openAiPromptModal('draw', 'AI 繪圖', '描述想要的圖片，例如：水彩風格的台灣夜市…');
        else if (act === 'search') openAiPromptModal('search', '聯網搜索', '輸入要搜尋的問題…');
        else if (act === 'chat') toggleAiChat();
        else if (act === 'cfg') openAiCfgModal();
    }

    /* ---------------- P7：演示模式（Pitch） ---------------- */
    var EASE = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

    /* 投影片序列：中心樹 DFS，depth ≤ pitchDepth；每個浮動根各自一張。第 0 張＝全圖（central）。 */
    function pitchDepth() {
        var pr = safeParseProps(state.mapProps);
        var d = pr && pr.pitch && pr.pitch.depth;
        return (typeof d === 'number' && d >= 0) ? d : 2;
    }

    function slides() {
        var out = [];
        var idx = buildChildIndex();
        var maxD = pitchDepth();
        function walk(id, depth) {
            var n = node(id);
            if (!n) return;
            out.push(n.id);
            if (depth >= maxD) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id, depth + 1);
        }
        if (node(state.centralId)) walk(state.centralId, 0);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) out.push(fls[fi].id);
        return out;
    }

    /* 該投影片焦點子樹的所有可見節點 id（Set） */
    function slideFocusSet(rootId) {
        var set = {};
        var idx = buildChildIndex();
        function walk(id) {
            var n = node(id);
            if (!n) return;
            set[id] = true;
            if (n.collapsed) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(rootId);
        return set;
    }

    /* 焦點子樹的外接框（已擺位座標，供鏡頭運算） */
    function slideBBox(rootId) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
        var idx = buildChildIndex();
        function walk(id) {
            var n = node(id);
            if (!n || n.cx == null) return;
            any = true;
            minX = Math.min(minX, n.cx - n.w / 2);
            maxX = Math.max(maxX, n.cx + n.w / 2);
            minY = Math.min(minY, n.cy - n.h / 2);
            maxY = Math.max(maxY, n.cy + n.h / 2);
            if (n.collapsed) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(rootId);
        if (!any) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    function enterPitch() {
        if (state.pitch || !node(state.centralId)) return;
        var list = slides();
        if (!list.length) { toast('沒有可以演示的內容'); return; }
        if (state.editingId || state.editingRelId || state.editingBoundaryId) commitEdit(true);
        state.selectedId = null; state.selectedIds = [];
        state.selectedRelId = null; state.selectedBoundaryId = null;
        state.pitch = {
            slides: list, idx: -1,
            savedView: { panX: state.panX, panY: state.panY, scale: state.scale },
            expanded: [], raf: null
        };
        document.body.classList.add('presenting');
        if (els.pitchBar) els.pitchBar.classList.remove('hidden');
        goSlide(0);
    }

    function exitPitch() {
        var p = state.pitch;
        if (!p) return;
        if (p.raf) { try { cancelAnimationFrame(p.raf); } catch (e) { } }
        for (var i = 0; i < p.expanded.length; i++) {
            var n = node(p.expanded[i]);
            if (n) n.collapsed = true;
        }
        state.pitch = null;
        document.body.classList.remove('presenting');
        if (els.pitchBar) els.pitchBar.classList.add('hidden');
        state.panX = p.savedView.panX;
        state.panY = p.savedView.panY;
        state.scale = p.savedView.scale;
        setViewport();
        layoutAll();
        render();
        clearSpotlight();
    }

    function clearSpotlight() {
        if (!els.nodeLayer) return;
        var all = els.svg.querySelectorAll('.mm-node, #linkLayer path, #relLayer path, #boundaryLayer rect, #boundaryLayer path, #summaryLayer path');
        for (var i = 0; i < all.length; i++) all[i].style.opacity = '';
    }

    function applySpotlight(focusSet) {
        if (!els.svg) return;
        var nodes = els.svg.querySelectorAll('#nodeLayer .mm-node[data-id]');
        var i;
        for (i = 0; i < nodes.length; i++) {
            var id = nodes[i].getAttribute('data-id');
            nodes[i].style.opacity = focusSet[id] ? '1' : '0.15';
        }
        var links = els.svg.querySelectorAll('#linkLayer path[data-cid]');
        for (i = 0; i < links.length; i++) {
            links[i].style.opacity = focusSet[links[i].getAttribute('data-cid')] ? '1' : '0.15';
        }
        var rels = els.svg.querySelectorAll('#relLayer path[data-rel]');
        for (i = 0; i < rels.length; i++) rels[i].style.opacity = '0.15';
        var bnds = els.svg.querySelectorAll('#boundaryLayer rect, #boundaryLayer path');
        for (i = 0; i < bnds.length; i++) bnds[i].style.opacity = '0.15';
        var sums = els.svg.querySelectorAll('#summaryLayer path[data-summary]');
        for (i = 0; i < sums.length; i++) {
            var sid = sums[i].getAttribute('data-summary');
            var sRec = null;
            for (var si = 0; si < state.summaries.length; si++) if (state.summaries[si].summaryId === sid) sRec = state.summaries[si];
            sums[i].style.opacity = (sRec && focusSet[sRec.parentId]) ? '1' : '0.15';
        }
    }

    /* rAF 逐幀插值 pan/scale；沒有 rAF 的環境（如 jsdom）直接一步到位 */
    function animateView(target, duration) {
        var hasRaf = (typeof window !== 'undefined') && typeof window.requestAnimationFrame === 'function';
        if (!hasRaf) {
            state.panX = target.panX; state.panY = target.panY; state.scale = target.scale;
            setViewport();
            return;
        }
        var p = state.pitch;
        if (p && p.raf) { try { cancelAnimationFrame(p.raf); } catch (e) { } }
        var from = { panX: state.panX, panY: state.panY, scale: state.scale };
        var t0 = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
        function step() {
            var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
            var t = Math.min(1, (now - t0) / duration);
            var e = EASE(t);
            state.panX = from.panX + (target.panX - from.panX) * e;
            state.panY = from.panY + (target.panY - from.panY) * e;
            state.scale = from.scale + (target.scale - from.scale) * e;
            setViewport();
            if (t < 1 && state.pitch) {
                state.pitch.raf = window.requestAnimationFrame(step);
            } else if (state.pitch) {
                state.pitch.raf = null;
            }
        }
        state.pitch.raf = window.requestAnimationFrame(step);
    }

    function goSlide(i) {
        var p = state.pitch;
        if (!p) return;
        i = Math.max(0, Math.min(p.slides.length - 1, i));
        p.idx = i;
        var rootId = p.slides[i];

        /* 摺疊中的子樹：臨時展開祖先，離場時還原 */
        var cur = node(rootId), guard = 0;
        while (cur && cur.parentId && guard++ < 10000) {
            cur = node(cur.parentId);
            if (cur && cur.collapsed) {
                cur.collapsed = false;
                p.expanded.push(cur.id);
            }
        }
        layoutAll();

        var bb = slideBBox(rootId) || contentBBox();
        var margin = 80;
        var vw = els.stage.clientWidth || 1200, vh = els.stage.clientHeight || 800;
        var s = Math.min((vw - margin * 2) / Math.max(1, bb.w), (vh - margin * 2) / Math.max(1, bb.h));
        s = Math.max(0.25, Math.min(2, s));
        var target = {
            scale: s,
            panX: vw / 2 - s * (bb.x + bb.w / 2),
            panY: vh / 2 - s * (bb.y + bb.h / 2)
        };

        render();
        animateView(target, 400);
        applySpotlight(slideFocusSet(rootId));

        var rn = node(rootId);
        if (els.pitchTitle) els.pitchTitle.textContent = (rn && rn.text) || '';
        if (els.pitchIdx) els.pitchIdx.textContent = (i + 1) + ' / ' + p.slides.length;
    }

    function pitchNext() { if (state.pitch) goSlide(state.pitch.idx + 1); }
    function pitchPrev() { if (state.pitch) goSlide(state.pitch.idx - 1); }

    /* ---------------- P6：附圖與附檔（Files） ---------------- */
    var mmFileCache = {};   /* fileId → data URL（圖片顯示與匯出共用，避開 CORS） */
    var TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    function fileUrl(fileId, dl) {
        return mmFileCache[fileId] || TRANSPARENT_PX;
    }

    /* 把目前所有節點引用到的圖片 fileId 解析成 data URL 存進快取，完成後重繪 */
    function resolveImages() {
        var need = {};
        for (var k in state.nodes) {
            var pr = state.nodes[k] && state.nodes[k].props;
            if (pr && pr.image && pr.image.fileId && !mmFileCache[pr.image.fileId]) need[pr.image.fileId] = 1;
        }
        var ids = Object.keys(need);
        if (!ids.length) return Promise.resolve();
        return Promise.all(ids.map(function (fid) {
            return api('getfile', { qs: { fileId: fid } }).then(function (res) {
                if (res && res.ok && res.dataUrl) mmFileCache[fid] = res.dataUrl;
            }).catch(function () { });
        })).then(function () { render(); });
    }

    function uploadFile(file) {
        if (!state.mapId) return Promise.reject(new Error('尚未開啟心智圖'));
        if (file.size > 8 * 1024 * 1024) { toast('檔案超過大小上限（8MB）', true); return Promise.reject(new Error('too large')); }
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () {
                var dataUrl = String(fr.result || '');
                var comma = dataUrl.indexOf(',');
                var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
                api('uploadfile', { body: {
                    mapId: String(state.mapId), fileName: file.name,
                    contentType: file.type || 'application/octet-stream', dataBase64: b64
                } }).then(function (res) {
                    if (!res || !res.ok) throw new Error((res && res.error) || '上傳失敗');
                    mmFileCache[res.fileId] = dataUrl;   /* 立即可顯示，免再下載 */
                    resolve(res);
                }).catch(reject);
            };
            fr.onerror = function () { reject(new Error('讀取檔案失敗')); };
            fr.readAsDataURL(file);
        });
    }

    /* 圖片：每節點最多一張，寬高依 200px 上限等比縮放後存 props.image */
    function insertImage(id, file) {
        if (!node(id) || node(id).type === 'callout') return Promise.resolve();
        return uploadFile(file).then(function (res) {
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () {
                    var maxW = 200, maxH = 140;
                    var w = img.naturalWidth || 100, h = img.naturalHeight || 100;
                    var s = Math.min(1, maxW / w, maxH / h);
                    setProps(id, { image: { fileId: res.fileId, w: Math.round(w * s), h: Math.round(h * s) } });
                    resolve(res);
                };
                img.onerror = function () {
                    setProps(id, { image: { fileId: res.fileId, w: 160, h: 100 } });
                    resolve(res);
                };
                img.src = fileUrl(res.fileId);
            });
        }).catch(function (e) { toast('圖片上傳失敗：' + e.message, true); });
    }

    function removeImage(id) {
        setProps(id, { image: null });
        purgeFilesSoon();
    }

    /* 附檔：每節點可多個，存 props.attachments[] */
    function addAttachment(id, file) {
        if (!node(id) || node(id).type === 'callout') return Promise.resolve();
        return uploadFile(file).then(function (res) {
            var n = node(id);
            var cur = (n.props && Array.isArray(n.props.attachments)) ? n.props.attachments.slice() : [];
            cur.push({ fileId: res.fileId, fileName: res.fileName, byteSize: res.byteSize });
            setProps(id, { attachments: cur });
            return res;
        }).catch(function (e) { toast('附檔上傳失敗：' + e.message, true); });
    }

    function removeAttachment(id, fileId) {
        var n = node(id);
        var cur = (n && n.props && Array.isArray(n.props.attachments)) ? n.props.attachments.slice() : [];
        var next = cur.filter(function (a) { return a.fileId !== fileId; });
        setProps(id, { attachments: next.length ? next : null });
        purgeFilesSoon();
    }

    function downloadAttachment(fileId) {
        api('getfile', { qs: { fileId: fileId } }).then(function (res) {
            if (!res || !res.ok || !res.dataUrl) throw new Error((res && res.error) || '下載失敗');
            var a = document.createElement('a');
            a.href = res.dataUrl; a.download = res.fileName || 'download';
            document.body.appendChild(a); a.click(); a.remove();
        }).catch(function (e) { toast('下載失敗：' + e.message, true); });
    }

    /* 存檔後順手清一次孤兒檔案（不阻塞 UI，失敗靜默） */
    var _purgeTimer = null;
    function purgeFilesSoon() {
        if (!state.mapId) return;
        if (_purgeTimer) clearTimeout(_purgeTimer);
        _purgeTimer = setTimeout(function () {
            api('purgefiles', { body: { mapId: state.mapId } }).catch(function () { });
        }, 4000);
    }

    /* 觸發檔案選擇（點擊隱藏 input），選好後回呼 */
    function pickFile(inputEl, onFile) {
        if (!inputEl) return;
        inputEl.value = '';
        inputEl.onchange = function () {
            var f = inputEl.files && inputEl.files[0];
            if (f) onFile(f);
        };
        inputEl.click();
    }

    /* 貼上剪貼簿圖片（選取節點時 Ctrl+V） */
    function handlePaste(e) {
        var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;   /* 輸入框內貼上照常，不搶圖片 */
        if (!state.selectedId || state.editingId ||
            state.editingRelId || state.editingBoundaryId) return;
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf('image/') === 0) {
                var f = items[i].getAsFile();
                if (f) { insertImage(state.selectedId, f); e.preventDefault(); }
                return;
            }
        }
    }

    /* ---------------- P3：關聯箭頭（Relationships） ---------------- */
    function findRel(relId) {
        for (var i = 0; i < state.relations.length; i++) {
            if (state.relations[i].relId === relId) return state.relations[i];
        }
        return null;
    }

    function addRelation(fromId, toId) {
        if (!fromId || !toId || fromId === toId) return null;          /* 自環略過 */
        if (!node(fromId) || !node(toId)) return null;
        for (var i = 0; i < state.relations.length; i++) {
            var r = state.relations[i];
            if (r.fromId === fromId && r.toId === toId) return null;   /* 重複略過 */
        }
        pushUndo();
        var relId = uid();
        state.relations.push({ relId: relId, fromId: fromId, toId: toId, label: null, props: null });
        state.selectedRelId = relId;
        state.selectedId = null;
        state.selectedIds = [];
        afterMutate();
        return relId;
    }

    function removeRelation(relId) {
        for (var i = 0; i < state.relations.length; i++) {
            if (state.relations[i].relId === relId) {
                pushUndo();
                state.relations.splice(i, 1);
                if (state.selectedRelId === relId) state.selectedRelId = null;
                afterMutate();
                return true;
            }
        }
        return false;
    }

    function setRelationLabel(relId, label) {
        var r = findRel(relId);
        if (!r) return;
        var v = (label != null && ('' + label).trim()) ? ('' + label).trim() : null;
        if (v === r.label) return;
        pushUndo();
        r.label = v;
        afterMutate();
    }

    /* 彎曲：props.bend（props 一律以 JSON 字串保存，讀寫時解析/回寫） */
    function setRelationBend(relId, mx, my) {
        var r = findRel(relId);
        if (!r) return;
        pushUndo();
        var pr = safeParseProps(r.props) || {};
        pr.bend = { mx: mx, my: my };
        r.props = propsToStr(pr);
        afterMutate();
    }

    function clearRelationBend(relId) {
        var r = findRel(relId);
        if (!r) return;
        var pr = safeParseProps(r.props);
        if (!pr || !pr.bend) return;
        pushUndo();
        delete pr.bend;
        r.props = propsToStr(pr);
        afterMutate();
    }

    function selectRelation(relId) {
        state.selectedRelId = relId;
        state.selectedId = null;
        state.selectedIds = [];
        render();
    }

    /* 連線模式：右鍵「建立關聯 →」啟動，點擊目標節點完成，Esc 取消 */
    function startLinking(fromId) {
        if (!node(fromId)) return;
        state.linking = { fromId: fromId };
        if (els.svg) els.svg.style.cursor = 'crosshair';
        toast('點擊目標主題建立關聯，Esc 取消');
    }

    function cancelLinking() {
        state.linking = null;
        if (els.svg) els.svg.style.cursor = '';
        if (els.dropHint) els.dropHint.textContent = '';
    }

    function removeNode(id) {
        var n = node(id);
        if (!n) return;
        if (id === state.centralId) { toast('中心主題無法刪除'); return; }
        pushUndo();
        var doomed = [id];
        (function collect(pid) {
            var kids = childrenOf(pid, true);   /* 含 callout/summary，一併刪除 */
            for (var i = 0; i < kids.length; i++) { doomed.push(kids[i].id); collect(kids[i].id); }
        })(id);
        var parentId = n.parentId;
        var dm = {};
        for (var i = 0; i < doomed.length; i++) { dm[doomed[i]] = true; delete state.nodes[doomed[i]]; }
        pruneRefs(dm);   /* 引用到被刪節點的 relations / boundaries / summaries 一併移除 */
        if (parentId && state.nodes[parentId]) {
            normalizeOrders(parentId);
            state.selectedId = parentId;
        } else {
            state.selectedId = state.centralId;   /* 刪除浮動根：回選中心主題 */
        }
        state.selectedIds = state.selectedId ? [state.selectedId] : [];
        afterMutate();
    }

    function setText(id, text) {
        var n = node(id);
        if (!n) return;
        var t = String(text == null ? '' : text);
        if (t.trim() === '') t = (id === state.centralId) ? '中心主題' : '未命名';
        if (t === n.text) { render(); return; }
        pushUndo();
        n.text = t;
        afterMutate();
    }

    function toggleCollapse(id) {
        var n = node(id);
        if (!n || id === state.centralId) return;
        if (!childrenOf(id).length) return;
        pushUndo();
        n.collapsed = !n.collapsed;
        afterMutate();
    }

    function setColor(id, color) {
        var n = node(id);
        if (!n) return;
        pushUndo();
        n.color = color || null;
        afterMutate();
    }

    /* 拖放搬移：zone = 'child' | 'before' | 'after' */
    function applyReparent(dragId, targetId, zone, worldX) {
        var d = node(dragId), t = node(targetId);
        if (!d || !t || dragId === targetId) return;
        if (isDescendant(dragId, targetId)) return;      /* 不能搬進自己的子孫 */
        pushUndo();

        /* 浮動主題拖回樹上：轉為一般節點；任何節點重新掛接都回到自動排列 */
        if (d.type === 'floating') d.type = 'topic';
        d.posX = null;
        d.posY = null;

        var oldParent = d.parentId;

        if (zone === 'child' || targetId === state.centralId) {
            d.parentId = targetId;
            d.sortOrder = 99999;
            d.side = (targetId === state.centralId) ? ((worldX != null && worldX < 0) ? 'L' : 'R') : null;
            normalizeOrders(targetId);
        } else {
            d.parentId = t.parentId;
            d.side = (t.parentId === state.centralId) ? sideOf(t) : null;
            var sibs = childrenOf(t.parentId);
            var others = [];
            for (var i = 0; i < sibs.length; i++) if (sibs[i].id !== dragId) others.push(sibs[i]);
            var pos = 0;
            for (i = 0; i < others.length; i++) if (others[i].id === targetId) { pos = i; break; }
            if (zone === 'after') pos++;
            others.splice(pos, 0, d);
            for (i = 0; i < others.length; i++) others[i].sortOrder = (i + 1) * 10;
        }
        if (oldParent && oldParent !== d.parentId) normalizeOrders(oldParent);
        afterMutate();
        select(dragId);
    }

    /* ---------------- 序列化（存檔／快照用；§4.1 doc 契約） ---------------- */
    function serializeDoc() {
        var nodes = [];
        var idx = buildChildIndex(true);   /* 含 callout/summary，完整輸出 */

        function pushNode(n) {
            nodes.push({
                id: n.id,
                parentId: n.parentId || null,
                text: n.text || '',
                sortOrder: n.sortOrder | 0,
                collapsed: !!n.collapsed,
                side: (n.parentId === state.centralId && n.type === 'topic') ? sideOf(n) : null,
                color: n.color || null,
                type: n.type || 'topic',
                posX: ((n.type === 'floating' || n.type === 'topic') && typeof n.posX === 'number') ? n.posX : null,
                posY: ((n.type === 'floating' || n.type === 'topic') && typeof n.posY === 'number') ? n.posY : null,
                structure: n.structure || null,
                props: propsToStr(n.props)
            });
        }
        function walk(id) {
            var n = node(id);
            if (!n) return;
            pushNode(n);
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(state.centralId);
        var fls = floatingRoots(), i;
        for (i = 0; i < fls.length; i++) walk(fls[i].id);

        var relations = [], boundaries = [], summaries = [];
        for (i = 0; i < state.relations.length; i++) {
            var r = state.relations[i];
            if (!state.nodes[r.fromId] || !state.nodes[r.toId]) continue;
            relations.push({ relId: r.relId, fromId: r.fromId, toId: r.toId, label: r.label || null, props: r.props || null });
        }
        for (i = 0; i < state.boundaries.length; i++) {
            var b = state.boundaries[i];
            var bmOut = normalizeMembers(b);
            if (!bmOut.length) continue;
            boundaries.push({ boundaryId: b.boundaryId, memberIds: bmOut, label: b.label || null, props: b.props || null });
        }
        for (i = 0; i < state.summaries.length; i++) {
            var s = state.summaries[i];
            if (!state.nodes[s.parentId] || !state.nodes[s.fromChildId] || !state.nodes[s.toChildId] || !state.nodes[s.topicId]) continue;
            summaries.push({ summaryId: s.summaryId, parentId: s.parentId, fromChildId: s.fromChildId, toChildId: s.toChildId, topicId: s.topicId });
        }

        return {
            title: state.title || '',
            structure: state.mapStructure || 'mindmap',
            theme: state.mapTheme || 'classic',
            props: state.mapProps || null,
            nodes: nodes,
            relations: relations,
            boundaries: boundaries,
            summaries: summaries
        };
    }

    /* v1 相容薄包裝（測試與外部呼叫仍可用） */
    function serializeNodes() { return serializeDoc().nodes; }

    /* ---------------- 後端 API ---------------- */
    function apiBase() { return (localStorage.getItem('mm.apiUrl') || '').trim(); }

    function api(action, opts) {
        opts = opts || {};
        var base = apiBase();
        if (!base) return Promise.reject(new Error('尚未設定後端 API 網址（請點右下角 ⚙ 設定）'));
        var init, url = base;
        if (opts.body) {
            /* 寫入：POST；用 text/plain 避免 CORS 預檢，action 併入 body */
            init = { method: 'POST', redirect: 'follow',
                     headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                     body: JSON.stringify(Object.assign({ action: action }, opts.body)) };
        } else {
            /* 讀取：GET，參數走 querystring */
            url += (base.indexOf('?') >= 0 ? '&' : '?') + 'action=' + encodeURIComponent(action);
            if (opts.qs) for (var k in opts.qs) url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(opts.qs[k]);
            init = { method: 'GET', redirect: 'follow' };
        }
        return fetch(url, init).then(function (r) {
            return r.text().then(function (t) {
                try {
                    return JSON.parse(t);
                } catch (e) {
                    throw new Error('後端沒有回傳 JSON（HTTP ' + r.status + '）。請確認 Apps Script 網址結尾為 /exec、' +
                                    '且部署時「具有存取權的使用者」設為「任何人」。');
                }
            });
        });
    }

    function saveMap(silent) {
        if (!state.mapId || state.saving) return Promise.resolve();
        state.saving = true;
        updateSaveUI('saving');
        var doc = serializeDoc();
        doc.mapId = state.mapId;
        doc.sheetId = state.sheetId;
        return api('savemap', { body: doc })
            .then(function (res) {
                if (res && res.ok) {
                    state.dirty = false;
                    state.lastSaved = new Date();
                    if (!silent) toast('已儲存');
                    refreshMapList();
                    purgeFilesSoon();
                } else {
                    throw new Error((res && res.error) || '儲存失敗');
                }
            })
            .catch(function (e) { toast('儲存失敗：' + e.message, true); })
            .then(function () { state.saving = false; updateSaveUI(); });
    }

    /* ---- 白名單（修復規則 1）---- */
    var NODE_TYPES = { central: 1, topic: 1, floating: 1, callout: 1, summary: 1 };
    var STRUCT_NAMES = { 'logic-right': 1, 'logic-left': 1, 'org-down': 1, 'tree-right': 1 };

    /* hydrateDoc：把 doc（後端 loadmap 回應或 undo 快照）灌回 state，
       同時執行 §3.3 修復規則。loadIntoState 與 restore 共用。 */
    function hydrateDoc(doc) {
        doc = doc || {};
        state.title = doc.title || '';
        var ms = ('' + (doc.structure || 'mindmap')).toLowerCase();
        state.mapStructure = (ms === 'mindmap' || STRUCT_NAMES[ms]) ? ms : 'mindmap';
        state.mapTheme = (doc.theme === 'dark') ? 'dark' : 'classic';
        state.mapProps = (typeof doc.props === 'string' && doc.props) ? doc.props : null;

        state.nodes = {};
        var arr = doc.nodes || [], i, r, n, k;
        for (i = 0; i < arr.length; i++) {
            r = arr[i] || {};
            if (!r.id) continue;
            var ty = NODE_TYPES[r.type] ? r.type : 'topic';                    /* 規則 1 */
            var st = STRUCT_NAMES[r.structure] ? r.structure :
                     ((r.structure === 'mindmap' && ty === 'central') ? 'mindmap' : null);
            state.nodes[r.id] = {
                id: r.id,
                parentId: r.parentId || null,
                text: r.text || '',
                sortOrder: (r.sortOrder | 0),
                collapsed: !!r.collapsed,
                side: (r.side === 'L' || r.side === 'R') ? r.side : null,
                color: r.color || null,
                type: ty,
                posX: (typeof r.posX === 'number') ? r.posX : null,
                posY: (typeof r.posY === 'number') ? r.posY : null,
                structure: st,
                props: safeParseProps(r.props)
            };
        }

        /* 規則 2：找出中心主題（type=central 且無父 → 第一個無父非 floating 升級 → 補建） */
        state.centralId = null;
        for (k in state.nodes) {
            n = state.nodes[k];
            if (n.type === 'central' && !n.parentId) { state.centralId = k; break; }
        }
        if (!state.centralId) {
            for (k in state.nodes) {
                n = state.nodes[k];
                if (!n.parentId && n.type !== 'floating') { n.type = 'central'; state.centralId = k; break; }
            }
        }
        if (!state.centralId) {
            var rid = uid();
            state.nodes[rid] = blankNode(rid, null, '中心主題', 'central');
            state.centralId = rid;
        }
        node(state.centralId).parentId = null;

        /* 規則 3/5：孤兒掛回中心主題；多顆 central 降級；無效 callout 整筆丟棄 */
        for (k in state.nodes) {
            n = state.nodes[k];
            if (n.id === state.centralId) continue;
            if (n.type === 'floating' && !n.parentId) continue;
            if (n.type === 'callout') {
                if (!n.parentId || !state.nodes[n.parentId]) delete state.nodes[k];
                continue;
            }
            if (!n.parentId || !state.nodes[n.parentId]) {
                if (n.type === 'central') n.type = 'topic';
                n.parentId = state.centralId;
            }
        }

        /* 規則 4：floating 缺座標 → 錯落排列；非 floating 清空座標 */
        var fi = 0;
        for (k in state.nodes) {
            n = state.nodes[k];
            if (n.type === 'floating' && !n.parentId) {
                if (typeof n.posX !== 'number' || typeof n.posY !== 'number') {
                    n.posX = 260 + fi * 48;
                    n.posY = 200 + fi * 48;
                }
                fi++;
            } else if (n.type !== 'floating' && n.type !== 'topic') {
                n.posX = null; n.posY = null;   /* topic 允許帶固定位置（自由拖曳）；其餘型別不該有座標 */
            }
        }

        /* 規則 6：關聯線端點必須存在 */
        state.relations = [];
        var rels = doc.relations || [];
        for (i = 0; i < rels.length; i++) {
            r = rels[i] || {};
            if (!r.relId || !state.nodes[r.fromId] || !state.nodes[r.toId]) continue;
            state.relations.push({
                relId: r.relId, fromId: r.fromId, toId: r.toId,
                label: r.label || null,
                props: (typeof r.props === 'string' && r.props) ? r.props : null
            });
        }

        /* 規則 7：外框區間收縮/丟棄 */
        state.boundaries = [];
        var bs = doc.boundaries || [];
        for (i = 0; i < bs.length; i++) {
            var b = bs[i] || {};
            if (!b.boundaryId) continue;
            var bmem = normalizeMembers(b);   /* 新格式 memberIds；舊格式兄弟區間自動展開 */
            if (!bmem.length) continue;
            state.boundaries.push({
                boundaryId: b.boundaryId,
                memberIds: bmem,
                label: b.label || null,
                props: (typeof b.props === 'string' && b.props) ? b.props : null
            });
        }

        /* 規則 7/8：概要區間收縮；概要主題缺失時補建、存在則強制 type='summary' */
        state.summaries = [];
        var ss = doc.summaries || [];
        for (i = 0; i < ss.length; i++) {
            var s = ss[i] || {};
            var fx = fixRange(s.parentId, s.fromChildId, s.toChildId);
            if (!s.summaryId || !fx) continue;
            var topicId = s.topicId;
            if (!topicId || !state.nodes[topicId]) {
                topicId = uid();
                state.nodes[topicId] = blankNode(topicId, s.parentId, '概要', 'summary');
            } else {
                state.nodes[topicId].type = 'summary';
            }
            state.summaries.push({
                summaryId: s.summaryId, parentId: s.parentId,
                fromChildId: fx.from, toChildId: fx.to, topicId: topicId
            });
        }
    }

    function loadIntoState(res) {
        if (state.pitch) exitPitch();
        state.mapId = res.mapId;
        state.sheetId = res.sheetId || null;
        state.sheets = res.sheets || [];
        hydrateDoc(res);
        if (els.mapTitle) els.mapTitle.value = state.title;

        state.selectedId = state.centralId;
        state.selectedIds = [state.centralId];
        state.selectedRelId = null;
        state.selectedBoundaryId = null;
        state.linking = null;
        state.editingId = null;
        state.editingRelId = null;
        state.editingBoundaryId = null;
        state.linkFor = null;
        state.noteFor = null;
        state.picking = null;
        applyTheme();
        state.undoStack.length = 0;
        state.redoStack.length = 0;
        state.dirty = false;
        state.lastSaved = null;

        layoutAll();
        render();
        fitView();
        updateSaveUI();
        renderSheetBar();
        resolveImages();
        try {
            localStorage.setItem('mm.lastMapId', String(state.mapId));
            if (state.sheetId) localStorage.setItem('mm.lastSheet.' + state.mapId, String(state.sheetId));
        } catch (e) { }
    }

    /* ---------------- 分頁（Sheet，P0.5） ---------------- */
    function loadSheet(sheetId) {
        return api('loadmap', { qs: { mapId: state.mapId, sheetId: sheetId } }).then(function (res) {
            if (res && res.ok) loadIntoState(res);
            else toast((res && res.error) || '載入頁面失敗', true);
        }).catch(function (e) { toast('載入頁面失敗：' + e.message, true); });
    }

    /* 切頁：目前頁有未存變更 → 先自動存檔（失敗則停留原頁） */
    function switchSheet(sheetId) {
        if (!state.mapId || sheetId === state.sheetId) return Promise.resolve();
        var pre = state.dirty ? saveMap(true) : Promise.resolve();
        return pre.then(function () {
            if (state.dirty) { toast('切換前儲存失敗，仍停留在目前頁面', true); return; }
            return loadSheet(sheetId);
        });
    }

    function addSheet() {
        if (!state.mapId) return Promise.resolve();
        var pre = state.dirty ? saveMap(true) : Promise.resolve();
        return pre.then(function () {
            if (state.dirty) { toast('儲存失敗，暫時無法新增頁面', true); return; }
            return api('addsheet', { body: { mapId: state.mapId, title: '頁面 ' + (state.sheets.length + 1) } })
                .then(function (res) {
                    if (res && res.ok) return loadSheet(res.sheetId).then(function () { refreshMapList(); });
                    toast((res && res.error) || '新增頁面失敗', true);
                });
        }).catch(function (e) { toast('新增頁面失敗：' + e.message, true); });
    }

    function renameSheet(sheetId) {
        var cur = null;
        for (var i = 0; i < state.sheets.length; i++) if (state.sheets[i].sheetId === sheetId) cur = state.sheets[i];
        if (!cur) return Promise.resolve();
        var t = window.prompt('頁面名稱：', cur.title);
        if (t == null) return Promise.resolve();
        t = t.trim() || cur.title;
        return api('renamesheet', { body: { sheetId: sheetId, title: t } }).then(function (res) {
            if (res && res.ok) { cur.title = t; renderSheetBar(); }
            else toast((res && res.error) || '頁面改名失敗', true);
        }).catch(function (e) { toast('頁面改名失敗：' + e.message, true); });
    }

    function deleteSheet(sheetId) {
        if (state.sheets.length <= 1) { toast('每張心智圖至少需保留一個頁面'); return Promise.resolve(); }
        var cur = null;
        for (var i = 0; i < state.sheets.length; i++) if (state.sheets[i].sheetId === sheetId) cur = state.sheets[i];
        if (!cur) return Promise.resolve();
        if (!window.confirm('刪除頁面「' + cur.title + '」？此頁的所有內容將一併刪除，無法復原。')) return Promise.resolve();
        return api('deletesheet', { body: { sheetId: sheetId } }).then(function (res) {
            if (!res || !res.ok) { toast((res && res.error) || '刪除頁面失敗', true); return; }
            var next = state.sheetId;
            if (sheetId === state.sheetId) {
                next = null;
                for (var j = 0; j < state.sheets.length; j++) {
                    if (state.sheets[j].sheetId !== sheetId) { next = state.sheets[j].sheetId; break; }
                }
            }
            return loadSheet(next).then(function () { refreshMapList(); });
        }).catch(function (e) { toast('刪除頁面失敗：' + e.message, true); });
    }

    function renderSheetBar() {
        if (!els.sheetTabs) return;
        els.sheetTabs.textContent = '';
        for (var i = 0; i < state.sheets.length; i++) {
            (function (s) {
                var tab = document.createElement('div');
                tab.className = 'sheet-tab' + (s.sheetId === state.sheetId ? ' active' : '');
                tab.textContent = s.title;
                tab.title = '點擊切換 ・ 雙擊改名 ・ 右鍵刪除';
                tab.addEventListener('click', function () { switchSheet(s.sheetId); });
                tab.addEventListener('dblclick', function (ev) { ev.preventDefault(); renameSheet(s.sheetId); });
                tab.addEventListener('contextmenu', function (ev) { ev.preventDefault(); deleteSheet(s.sheetId); });
                els.sheetTabs.appendChild(tab);
            })(state.sheets[i]);
        }
    }

    function openMap(mapId) {
        if (state.dirty && !window.confirm('目前的心智圖尚未儲存，切換後將遺失變更。仍要切換嗎？')) {
            return Promise.resolve();
        }
        var qs = { mapId: mapId };
        try {
            var lastSheet = localStorage.getItem('mm.lastSheet.' + mapId);
            if (lastSheet) qs.sheetId = lastSheet;
        } catch (e) { }
        return api('loadmap', { qs: qs }).then(function (res) {
            if (res && res.ok) {
                loadIntoState(res);
                refreshMapList();   /* 固定式側欄：更新目前項目高亮，不收合 */
            } else {
                toast((res && res.error) || '載入失敗', true);
                return refreshMapList();
            }
        }).catch(function (e) { toast('載入失敗：' + e.message, true); });
    }

    function createNewMap() {
        var title = window.prompt('新的心智圖名稱：', '未命名心智圖');
        if (title == null) return Promise.resolve();
        title = title.trim() || '未命名心智圖';
        return api('createmap', { body: { title: title } }).then(function (res) {
            if (res && res.ok) {
                return refreshMapList().then(function () { return openMap(res.mapId); });
            }
            toast((res && res.error) || '建立失敗', true);
        }).catch(function (e) { toast('建立失敗：' + e.message, true); });
    }

    function renameMapById(mapId, oldTitle) {
        var title = window.prompt('重新命名：', oldTitle || '');
        if (title == null) return;
        title = title.trim();
        if (!title) return;
        api('renamemap', { body: { mapId: mapId, title: title } }).then(function (res) {
            if (res && res.ok) {
                if (mapId === state.mapId) {
                    state.title = title;
                    if (els.mapTitle) els.mapTitle.value = title;
                }
                refreshMapList();
            } else toast((res && res.error) || '命名失敗', true);
        });
    }

    function deleteMapById(mapId, title) {
        if (!window.confirm('確定刪除「' + (title || '') + '」？整張圖與所有節點將一併刪除，無法復原。')) return;
        api('deletemap', { body: { mapId: mapId } }).then(function (res) {
            if (!(res && res.ok)) { toast((res && res.error) || '刪除失敗', true); return; }
            toast('已刪除');
            refreshMapList().then(function (maps) {
                if (mapId === state.mapId) {
                    state.dirty = false;
                    if (maps.length) openMap(maps[0].mapId);
                    else {
                        api('createmap', { body: { title: '未命名心智圖' } }).then(function (r2) {
                            if (r2 && r2.ok) refreshMapList().then(function () { openMap(r2.mapId); });
                        });
                    }
                }
            });
        });
    }

    function refreshMapList() {
        return api('listmaps').then(function (res) {
            var maps = (res && res.ok && res.maps) ? res.maps : [];
            var folders = (res && res.ok && res.folders) ? res.folders : [];
            renderMapList(maps, folders);
            return { maps: maps, folders: folders };
        }).catch(function () { renderMapList([], []); return { maps: [], folders: [] }; });
    }

    /* 資料夾展開狀態（localStorage，JSON 物件 {folderId: 1}） */
    function readFolderOpenSet() {
        try {
            var s = localStorage.getItem('mm.folderOpen');
            return s ? JSON.parse(s) : {};
        } catch (e) { return {}; }
    }
    function writeFolderOpenSet(set) {
        try { localStorage.setItem('mm.folderOpen', JSON.stringify(set)); } catch (e) { }
    }

    function renderMapList(maps, folders) {
        var box = els.mapList;
        if (!box) return;
        maps = maps || [];
        folders = folders || [];
        box.textContent = '';
        if (!maps.length && !folders.length) {
            var empty = document.createElement('div');
            empty.className = 'drawer-empty';
            empty.textContent = '還沒有任何心智圖，按「＋新增」開始。';
            box.appendChild(empty);
            return;
        }
        var openSet = readFolderOpenSet();

        function buildMapItem(m, nested) {
            var item = document.createElement('div');
            item.className = 'map-item' + (nested ? ' nested' : '') + (m.mapId === state.mapId ? ' current' : '');

            var info = document.createElement('div');
            info.className = 'info';
            var t = document.createElement('div');
            t.className = 't';
            t.textContent = m.title;
            var meta = document.createElement('div');
            meta.className = 'm';
            meta.textContent = (m.nodeCount || 0) + ' 個節點 ・ ' + (m.updatedAt || '');
            info.appendChild(t); info.appendChild(meta);

            var ops = document.createElement('div');
            ops.className = 'ops';
            var bRen = document.createElement('button');
            bRen.className = 'mini-btn'; bRen.title = '重新命名'; bRen.textContent = '✎';
            bRen.addEventListener('click', function (ev) { ev.stopPropagation(); renameMapById(m.mapId, m.title); });
            var bDel = document.createElement('button');
            bDel.className = 'mini-btn danger'; bDel.title = '刪除'; bDel.textContent = '🗑';
            bDel.addEventListener('click', function (ev) { ev.stopPropagation(); deleteMapById(m.mapId, m.title); });
            ops.appendChild(bRen); ops.appendChild(bDel);

            item.appendChild(info); item.appendChild(ops);
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', function (ev) {
                if (ev.dataTransfer) {
                    ev.dataTransfer.setData('text/plain', String(m.mapId));
                    ev.dataTransfer.effectAllowed = 'move';
                }
            });
            item.addEventListener('click', function () {
                if (m.mapId !== state.mapId) openMap(m.mapId);
            });
            item.addEventListener('contextmenu', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                showMapItemMenu(ev.clientX, ev.clientY, m, folders);
            });
            return item;
        }

        /* 資料夾群組 */
        for (var fi = 0; fi < folders.length; fi++) {
            (function (f) {
                var inFolder = maps.filter(function (m) { return m.folderId === f.folderId; });
                var isOpen = !!openSet[f.folderId];
                var row = document.createElement('div');
                row.className = 'folder-row';
                var tw = document.createElement('span');
                tw.className = 'tw';
                tw.textContent = isOpen ? '▾' : '▸';
                var name = document.createElement('span');
                name.textContent = '📁 ' + f.title;
                var cnt = document.createElement('span');
                cnt.className = 'cnt';
                cnt.textContent = inFolder.length ? String(inFolder.length) : '';
                row.appendChild(tw); row.appendChild(name); row.appendChild(cnt);
                row.addEventListener('click', function () {
                    var s2 = readFolderOpenSet();
                    if (s2[f.folderId]) delete s2[f.folderId]; else s2[f.folderId] = 1;
                    writeFolderOpenSet(s2);
                    refreshMapList();
                });
                row.addEventListener('contextmenu', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    showFolderMenu(ev.clientX, ev.clientY, f);
                });
                row.addEventListener('dragover', function (ev) {
                    ev.preventDefault();
                    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                    row.classList.add('drop-target');
                });
                row.addEventListener('dragleave', function () { row.classList.remove('drop-target'); });
                row.addEventListener('drop', function (ev) {
                    ev.preventDefault();
                    row.classList.remove('drop-target');
                    var mid = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
                    if (mid) moveMapToFolder(mid, f.folderId);
                });
                box.appendChild(row);
                if (isOpen) {
                    for (var mi = 0; mi < inFolder.length; mi++) box.appendChild(buildMapItem(inFolder[mi], true));
                    if (!inFolder.length) {
                        var em = document.createElement('div');
                        em.className = 'drawer-sec';
                        em.style.marginLeft = '24px';
                        em.textContent = '（空資料夾）';
                        box.appendChild(em);
                    }
                }
            })(folders[fi]);
        }

        /* 未分類 */
        var loose = maps.filter(function (m) { return m.folderId == null; });
        if (folders.length && loose.length) {
            var sec = document.createElement('div');
            sec.className = 'drawer-sec';
            sec.textContent = '未分類（拖到這裡＝移出資料夾）';
            sec.addEventListener('dragover', function (ev) {
                ev.preventDefault();
                sec.classList.add('drop-target');
            });
            sec.addEventListener('dragleave', function () { sec.classList.remove('drop-target'); });
            sec.addEventListener('drop', function (ev) {
                ev.preventDefault();
                sec.classList.remove('drop-target');
                var mid = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
                if (mid) moveMapToFolder(mid, null);
            });
            box.appendChild(sec);
        }
        for (var li = 0; li < loose.length; li++) box.appendChild(buildMapItem(loose[li], false));
    }

    /* ---------------- P10：另存新檔＋資料夾 ---------------- */
    /* 側欄用的輕量選單（重用 #ctxMenu 與其樣式） */
    function drawerMenuBase(x, y) {
        var menu = els.ctxMenu;
        menu.textContent = '';
        function item(label, fn, danger) {
            var d = document.createElement('div');
            d.className = 'ctx-item' + (danger ? ' danger' : '');
            var sp = document.createElement('span');
            sp.textContent = label;
            d.appendChild(sp);
            d.addEventListener('click', function () { hideCtxMenu(); fn(); });
            menu.appendChild(d);
        }
        function sep() {
            var s = document.createElement('div');
            s.className = 'ctx-sep';
            menu.appendChild(s);
        }
        function show() {
            menu.classList.remove('hidden');
            var mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 160;
            var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
            menu.style.left = Math.min(x, vw - mw - 8) + 'px';
            menu.style.top = Math.min(y, vh - mh - 8) + 'px';
        }
        return { item: item, sep: sep, show: show };
    }

    function showMapItemMenu(x, y, m, folders) {
        var mb = drawerMenuBase(x, y);
        if (m.mapId !== state.mapId) mb.item('開啟', function () { openMap(m.mapId); });
        mb.item('另存新檔…', function () { saveMapAsById(m.mapId, m.title); });
        mb.item('重新命名…', function () { renameMapById(m.mapId, m.title); });
        mb.sep();
        mb.item('移到資料夾 ▸', function () { showMoveToFolderMenu(x + 24, y + 8, m, folders); });
        mb.item('清理未使用檔案', function () {
            api('purgefiles', { body: { mapId: m.mapId } }).then(function (r) {
                toast((r && r.ok) ? ('已清理 ' + (r.deleted || 0) + ' 個未使用檔案') : '清理失敗', !(r && r.ok));
            }).catch(function () { toast('清理失敗', true); });
        });
        mb.sep();
        mb.item('刪除', function () { deleteMapById(m.mapId, m.title); }, true);
        mb.show();
    }

    function showMoveToFolderMenu(x, y, m, folders) {
        var mb = drawerMenuBase(x, y);
        for (var i = 0; i < folders.length; i++) {
            (function (f) {
                mb.item((m.folderId === f.folderId ? '✓ ' : '　') + '📁 ' + f.title, function () {
                    moveMapToFolder(m.mapId, f.folderId);
                });
            })(folders[i]);
        }
        if (folders.length) mb.sep();
        mb.item((m.folderId == null ? '✓ ' : '　') + '（未分類）', function () {
            moveMapToFolder(m.mapId, null);
        });
        mb.show();
    }

    function showFolderMenu(x, y, f) {
        var mb = drawerMenuBase(x, y);
        mb.item('重新命名資料夾…', function () {
            var t = window.prompt('資料夾名稱：', f.title);
            if (t == null) return;
            renameFolderNamed(f.folderId, t.trim() || f.title);
        });
        mb.item('刪除資料夾', function () { deleteFolderById(f.folderId, f.title); }, true);
        mb.show();
    }

    function createFolderNamed(title) {
        return api('createfolder', { body: { title: title } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '建立資料夾失敗');
            refreshMapList();
            return res;
        });
    }

    function createFolderPrompt() {
        var t = window.prompt('新資料夾名稱：', '新資料夾');
        if (t == null) return;
        createFolderNamed(t.trim() || '新資料夾').catch(function (e) { toast(e.message, true); });
    }

    function renameFolderNamed(folderId, title) {
        return api('renamefolder', { body: { folderId: folderId, title: title } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '重新命名失敗');
            return refreshMapList();
        }).catch(function (e) { toast(e.message, true); });
    }

    function deleteFolderById(folderId, title) {
        if (!window.confirm('刪除資料夾「' + (title || '') + '」？（裡面的心智圖會移到未分類）')) return Promise.resolve();
        return api('deletefolder', { body: { folderId: folderId } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '刪除失敗');
            return refreshMapList();
        }).catch(function (e) { toast(e.message, true); });
    }

    function moveMapToFolder(mapId, folderId) {
        return api('movemap', { body: { mapId: mapId, folderId: (folderId == null ? '' : folderId) } }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '搬移失敗');
            return refreshMapList();
        }).catch(function (e) { toast(e.message, true); });
    }

    /* 另存新檔：後端深層複製，成功後直接開啟複本 */
    function saveMapAsById(mapId, curTitle) {
        var def = (curTitle || '未命名心智圖') + '（複本）';
        var t = window.prompt('另存新檔的名稱：', def);
        if (t == null) return Promise.resolve();
        var name = (t.trim() || def);
        var pre = (mapId === state.mapId && state.dirty) ? saveMap(true) : Promise.resolve();
        return pre.then(function () {
            return api('savemapas', { body: { mapId: mapId, title: name } });
        }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || '另存失敗');
            toast('已另存為「' + res.title + '」');
            return openMap(res.mapId);
        }).catch(function (e) { toast('另存失敗：' + e.message, true); });
    }

    /* ---------------- 文字編輯覆蓋層 ---------------- */
    function startEdit(id, presetText, selectAll) {
        var n = node(id);
        if (!n || n.cx == null) return;
        commitEdit(true);
        state.editingId = id;
        state.selectedId = id;
        render();

        var ed = els.editor;
        var st = n._st || styleFor(n.depth || 0);
        var r = nodeScreenRect(n);
        var minW = Math.max(r.width, 140 * state.scale);
        ed.style.left = (r.left - (minW - r.width) / 2) + 'px';
        ed.style.top = r.top + 'px';
        ed.style.width = minW + 'px';
        ed.style.fontSize = (st.fs * state.scale) + 'px';
        ed.style.fontWeight = st.fw;
        ed.style.lineHeight = (st.lineH * state.scale) + 'px';
        ed.style.padding = (st.padY * state.scale) + 'px ' + (st.padX * state.scale * 0.6) + 'px';
        ed.value = (presetText != null) ? presetText : (n.text || '');
        ed.classList.remove('hidden');
        ed.style.height = 'auto';
        ed.style.height = Math.max(r.height, ed.scrollHeight) + 'px';
        ed.focus();
        if (selectAll) ed.select();
        else ed.setSelectionRange(ed.value.length, ed.value.length);
    }

    function commitEdit(save) {
        if (state.editingBoundaryId) {
            var bid2 = state.editingBoundaryId;
            state.editingBoundaryId = null;
            var edB = els.editor;
            var vB = edB.value;
            edB.classList.add('hidden');
            if (save) setBoundaryLabel(bid2, vB);
            else render();
            return;
        }
        if (state.editingRelId) {
            var rid = state.editingRelId;
            state.editingRelId = null;
            var ed0 = els.editor;
            var v0 = ed0.value;
            ed0.classList.add('hidden');
            if (save) setRelationLabel(rid, v0);
            else render();
            return;
        }
        if (!state.editingId) return;
        var id = state.editingId;
        state.editingId = null;
        var ed = els.editor;
        var val = ed.value;
        ed.classList.add('hidden');
        if (save) setText(id, val);
        else render();
    }

    /* ---------------- 右鍵選單 ---------------- */
    function hideCtxMenu() { els.ctxMenu.classList.add('hidden'); }

    /* ---------------- P5：樣式面板 ---------------- */
    function toggleStylePanel() {
        if (!els.stylePanel) return;
        els.stylePanel.classList.toggle('open');
        if (els.stylePanel.classList.contains('open')) refreshStylePanel();
    }

    function panelTargets() {
        var ids = state.selectedIds.length ? state.selectedIds.slice()
                : (state.selectedId ? [state.selectedId] : []);
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            var n = node(ids[i]);
            if (n && n.type !== 'callout') out.push(ids[i]);
        }
        return out;
    }

    function refreshStylePanel() {
        if (!els.stylePanel || !els.stylePanel.classList.contains('open')) return;
        var n = node(state.selectedId);
        if (els.spTheme) els.spTheme.value = state.mapTheme || 'classic';
        if (els.spStructure) {
            var isC = !n || n.id === state.centralId;
            var opts = [];
            if (isC) opts.push(['mindmap', '心智圖']);
            opts.push(['logic-right', '邏輯圖（右）'], ['logic-left', '邏輯圖（左）'],
                      ['org-down', '組織圖'], ['tree-right', '樹狀圖']);
            if (!isC) opts.push(['__inherit', '繼承父層']);
            els.spStructure.textContent = '';
            for (var oi = 0; oi < opts.length; oi++) {
                var op = document.createElement('option');
                op.value = opts[oi][0];
                op.textContent = opts[oi][1];
                els.spStructure.appendChild(op);
            }
            els.spStructure.value = isC ? (state.mapStructure || 'mindmap')
                                        : (n && n.structure ? n.structure : '__inherit');
        }
        var pr = (n && n.props) || {};
        if (els.spShapes) {
            var btns = els.spShapes.querySelectorAll('[data-shape]');
            var cur = pr.shape || 'auto';
            for (var bi = 0; bi < btns.length; bi++) {
                btns[bi].classList.toggle('active', btns[bi].getAttribute('data-shape') === cur);
            }
        }
        if (els.spFillHex) els.spFillHex.value = pr.fill || '';
        if (els.spBorderW) els.spBorderW.value = String((pr.border && pr.border.width) || 2);
        if (els.spBorderDash) els.spBorderDash.value = (pr.border && pr.border.dash) || 'solid';
        if (els.spFontVal) els.spFontVal.textContent = String((pr.font && pr.font.size) || (n && n._st ? n._st.fs : 15));
        if (els.spBold) els.spBold.classList.toggle('active', !!(pr.font && pr.font.bold));
        if (els.spItalic) els.spItalic.classList.toggle('active', !!(pr.font && pr.font.italic));
        if (els.spFixedW) els.spFixedW.checked = (pr.widthMode === 'fixed');
        if (els.spFixedWVal) els.spFixedWVal.value = String(pr.fixedWidth || 240);
        if (els.spMarkers) {
            var cur2 = Array.isArray(pr.markers) ? pr.markers : [];
            var mbs = els.spMarkers.querySelectorAll('[data-mk]');
            for (var mi2 = 0; mi2 < mbs.length; mi2++) {
                mbs[mi2].classList.toggle('active', cur2.indexOf(mbs[mi2].getAttribute('data-mk')) >= 0);
            }
        }
    }

    function bindStylePanel() {
        if (!els.stylePanel || !els.btnStylePanel) return;
        els.btnStylePanel.addEventListener('click', toggleStylePanel);
        els.spTheme.addEventListener('change', function () { setTheme(els.spTheme.value); });
        els.spStructure.addEventListener('change', function () {
            var v = els.spStructure.value;
            var n = node(state.selectedId);
            if (!n || n.id === state.centralId) setStructure(null, v);
            else setStructure(n.id, v === '__inherit' ? null : v);
            refreshStylePanel();
        });
        els.spShapes.addEventListener('click', function (e2) {
            var b = e2.target.closest ? e2.target.closest('[data-shape]') : null;
            if (!b) return;
            var v = b.getAttribute('data-shape');
            setProps(panelTargets(), { shape: v === 'auto' ? null : v });
        });
        els.spFills.addEventListener('click', function (e2) {
            var b = e2.target.closest ? e2.target.closest('[data-fill]') : null;
            if (!b) return;
            var v = b.getAttribute('data-fill');
            setProps(panelTargets(), { fill: v === 'none' ? null : v });
        });
        function applyHex() {
            var v = els.spFillHex.value.trim();
            var n = node(state.selectedId);
            var cur = (n && n.props && n.props.fill) || '';
            if (v === cur) return;
            if (!v) { setProps(panelTargets(), { fill: null }); return; }
            if (!/^#[0-9A-Fa-f]{6}$/.test(v)) { toast('請輸入 #RRGGBB 格式'); return; }
            setProps(panelTargets(), { fill: v });
        }
        els.spFillHex.addEventListener('keydown', function (e2) {
            if (e2.key === 'Enter') { e2.preventDefault(); applyHex(); }
        });
        els.spFillHex.addEventListener('blur', applyHex);
        els.spBorderW.addEventListener('change', function () {
            setProps(panelTargets(), { border: { width: parseInt(els.spBorderW.value, 10) || 2 } });
        });
        els.spBorderDash.addEventListener('change', function () {
            setProps(panelTargets(), { border: { dash: els.spBorderDash.value } });
        });
        function stepFont(d) {
            var n = node(state.selectedId);
            var cur = (n && n.props && n.props.font && n.props.font.size) || (n && n._st ? n._st.fs : 15);
            var v = Math.max(10, Math.min(40, cur + d));
            setProps(panelTargets(), { font: { size: v } });
        }
        els.spFontMinus.addEventListener('click', function () { stepFont(-1); });
        els.spFontPlus.addEventListener('click', function () { stepFont(1); });
        els.spBold.addEventListener('click', function () {
            var n = node(state.selectedId);
            var cur = !!(n && n.props && n.props.font && n.props.font.bold);
            setProps(panelTargets(), { font: { bold: !cur } });
        });
        els.spItalic.addEventListener('click', function () {
            var n = node(state.selectedId);
            var cur = !!(n && n.props && n.props.font && n.props.font.italic);
            setProps(panelTargets(), { font: { italic: !cur } });
        });
        els.spFixedW.addEventListener('change', function () {
            if (els.spFixedW.checked) {
                var v = parseInt(els.spFixedWVal.value, 10) || 240;
                setProps(panelTargets(), { widthMode: 'fixed', fixedWidth: Math.max(60, Math.min(600, v)) });
            } else {
                setProps(panelTargets(), { widthMode: null, fixedWidth: null });
            }
        });
        els.spFixedWVal.addEventListener('change', function () {
            if (!els.spFixedW.checked) return;
            var v = parseInt(els.spFixedWVal.value, 10) || 240;
            setProps(panelTargets(), { fixedWidth: Math.max(60, Math.min(600, v)) });
        });
        els.spMarkers.addEventListener('click', function (e2) {
            var b = e2.target.closest ? e2.target.closest('[data-mk]') : null;
            if (!b) return;
            var mkr = b.getAttribute('data-mk');
            var n = node(state.selectedId);
            var cur = (n && n.props && Array.isArray(n.props.markers)) ? n.props.markers.slice() : [];
            var ix = cur.indexOf(mkr);
            if (ix >= 0) cur.splice(ix, 1);
            else cur.push(mkr);
            setProps(panelTargets(), { markers: cur.length ? cur : null });
        });
        /* 連結／備註視窗按鈕 */
        els.lmTypeUrl.addEventListener('change', updateLinkModalMode);
        els.lmTypeTopic.addEventListener('change', updateLinkModalMode);
        els.lmOk.addEventListener('click', commitLinkModal);
        els.lmCancel.addEventListener('click', closeLinkModal);
        els.lmRemove.addEventListener('click', function () {
            if (state.linkFor) setProps(state.linkFor, { link: null });
            closeLinkModal();
        });
        els.lmValue.addEventListener('keydown', function (e2) {
            if (e2.key === 'Enter') { e2.preventDefault(); commitLinkModal(); }
        });
        els.nmOk.addEventListener('click', commitNoteModal);
        els.nmCancel.addEventListener('click', closeNoteModal);
        els.nmRemove.addEventListener('click', function () {
            if (state.noteFor) setProps(state.noteFor, { note: null });
            closeNoteModal();
        });
    }

    /* 空白處右鍵選單 */
    function showCanvasMenu(x, y, worldX, worldY) {
        var menu = els.ctxMenu;
        menu.textContent = '';
        function item(label, fn) {
            var d = document.createElement('div');
            d.className = 'ctx-item';
            var s = document.createElement('span');
            s.textContent = label;
            d.appendChild(s);
            d.addEventListener('click', function () { hideCtxMenu(); fn(); });
            menu.appendChild(d);
        }
        item('新增浮動主題', function () {
            var nid = addFloating(worldX, worldY);
            if (nid) startEdit(nid, null, true);
        });
        item('整理浮動主題', function () { tidyFloating(); });
        item('恢復全部自動排列', function () { clearAllPins(); });
        item('AI 生成心智圖…', function () { openAiMapModal(); });
        menu.classList.remove('hidden');
        var mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 100;
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        menu.style.left = Math.min(x, vw - mw - 8) + 'px';
        menu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    /* 關聯線右鍵選單 */
    function showRelMenu(x, y, relId) {
        var r = findRel(relId);
        if (!r) return;
        var menu = els.ctxMenu;
        menu.textContent = '';
        function item(label, fn, danger) {
            var d = document.createElement('div');
            d.className = 'ctx-item' + (danger ? ' danger' : '');
            var s = document.createElement('span');
            s.textContent = label;
            d.appendChild(s);
            d.addEventListener('click', function () { hideCtxMenu(); fn(); });
            menu.appendChild(d);
        }
        item('編輯標籤', function () { startRelEdit(relId); });
        var pr = safeParseProps(r.props);
        if (pr && pr.bend) item('拉直（清除彎曲）', function () { clearRelationBend(relId); });
        var sp = document.createElement('div');
        sp.className = 'ctx-sep';
        menu.appendChild(sp);
        item('刪除關聯', function () { removeRelation(relId); }, true);
        menu.classList.remove('hidden');
        var mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 120;
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        menu.style.left = Math.min(x, vw - mw - 8) + 'px';
        menu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    /* 外框右鍵選單 */
    function showBoundaryMenu(x, y, bid) {
        var b = findBoundary(bid);
        if (!b) return;
        var menu = els.ctxMenu;
        menu.textContent = '';
        function item(label, fn, danger) {
            var d = document.createElement('div');
            d.className = 'ctx-item' + (danger ? ' danger' : '');
            var s = document.createElement('span');
            s.textContent = label;
            d.appendChild(s);
            d.addEventListener('click', function () { hideCtxMenu(); fn(); });
            menu.appendChild(d);
        }
        item('編輯標籤', function () { startBoundaryEdit(bid); });
        /* 顏色列 */
        var row = document.createElement('div');
        row.className = 'ctx-item';
        row.style.display = 'flex';
        row.style.gap = '6px';
        row.style.alignItems = 'center';
        for (var ci = 0; ci < PALETTE.length; ci++) {
            (function (c) {
                var sw = document.createElement('span');
                sw.style.cssText = 'width:16px;height:16px;border-radius:4px;display:inline-block;cursor:pointer;background:' + c;
                sw.title = c;
                sw.addEventListener('click', function (ev) { ev.stopPropagation(); hideCtxMenu(); setBoundaryColor(bid, c); });
                row.appendChild(sw);
            })(PALETTE[ci]);
        }
        var clr = document.createElement('span');
        clr.textContent = '✕';
        clr.title = '清除顏色（回分支色）';
        clr.style.cssText = 'cursor:pointer;color:#888;margin-left:2px;';
        clr.addEventListener('click', function (ev) { ev.stopPropagation(); hideCtxMenu(); setBoundaryColor(bid, null); });
        row.appendChild(clr);
        menu.appendChild(row);
        var sp = document.createElement('div');
        sp.className = 'ctx-sep';
        menu.appendChild(sp);
        item('移除外框', function () { removeBoundary(bid); }, true);
        menu.classList.remove('hidden');
        var mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 140;
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        menu.style.left = Math.min(x, vw - mw - 8) + 'px';
        menu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    /* 編輯外框標籤：重用 #editor，定位到框頂 */
    function startBoundaryEdit(bid) {
        var b = findBoundary(bid);
        if (!b) return;
        var box = boundaryRangeBox(b);
        if (!box) return;
        commitEdit(true);
        selectBoundary(bid);
        state.editingBoundaryId = bid;

        var ed = els.editor;
        var wpx = 160 * state.scale;
        ed.style.left = (state.panX + state.scale * (box.x + 12)) + 'px';
        ed.style.top = (state.panY + state.scale * box.y - 12 * state.scale) + 'px';
        ed.style.width = wpx + 'px';
        ed.style.fontSize = (12 * state.scale) + 'px';
        ed.style.fontWeight = 500;
        ed.style.lineHeight = (17 * state.scale) + 'px';
        ed.style.padding = (3 * state.scale) + 'px ' + (7 * state.scale) + 'px';
        ed.value = b.label || '';
        ed.classList.remove('hidden');
        ed.style.height = 'auto';
        ed.style.height = Math.max(24 * state.scale, ed.scrollHeight) + 'px';
        ed.focus();
        ed.select();
    }

    /* 編輯關聯標籤：重用 #editor，定位到曲線中點 */
    function startRelEdit(relId) {
        var r = findRel(relId);
        if (!r) return;
        var a = node(r.fromId), b = node(r.toId);
        if (!a || !b || a.cx == null || b.cx == null) return;
        commitEdit(true);
        selectRelation(relId);
        state.editingRelId = relId;

        var pd = relPathD(r, a, b);
        var ed = els.editor;
        var wpx = 160 * state.scale;
        ed.style.left = (state.panX + state.scale * pd.mx - wpx / 2) + 'px';
        ed.style.top = (state.panY + state.scale * pd.my - 13 * state.scale) + 'px';
        ed.style.width = wpx + 'px';
        ed.style.fontSize = (12.5 * state.scale) + 'px';
        ed.style.fontWeight = 500;
        ed.style.lineHeight = (18 * state.scale) + 'px';
        ed.style.padding = (4 * state.scale) + 'px ' + (8 * state.scale) + 'px';
        ed.value = r.label || '';
        ed.classList.remove('hidden');
        ed.style.height = 'auto';
        ed.style.height = Math.max(26 * state.scale, ed.scrollHeight) + 'px';
        ed.focus();
        ed.select();
    }

    var STRUCT_LABELS = {
        'mindmap': '心智圖',
        'logic-right': '邏輯圖（右）',
        'logic-left': '邏輯圖（左）',
        'org-down': '組織圖',
        'tree-right': '樹狀圖'
    };

    /* 變更結構：id=null 或中心主題＝改整張圖（state.mapStructure）；其餘＝分支覆寫（name=null 清除覆寫） */
    function setStructure(id, name) {
        var ALLOWED = { 'logic-right': 1, 'logic-left': 1, 'org-down': 1, 'tree-right': 1 };
        if (id == null || id === state.centralId) {
            var v = (name === 'mindmap' || ALLOWED[name]) ? name : 'mindmap';
            if (v === state.mapStructure && !(node(state.centralId) || {}).structure) return;
            pushUndo();
            state.mapStructure = v;
            var c0 = node(state.centralId);
            if (c0) c0.structure = null;    /* 中心主題不留覆寫，整圖結構單一來源 */
            afterMutate();
            return;
        }
        var n = node(id);
        if (!n) return;
        var v2 = ALLOWED[name] ? name : null;
        if (v2 === n.structure) return;
        pushUndo();
        n.structure = v2;
        afterMutate();
    }

    /* 結構子選單（右鍵「變更結構…」進入） */
    function showStructureMenu(x, y, id) {
        var n = node(id);
        if (!n) return;
        var menu = els.ctxMenu;
        menu.textContent = '';
        var isCentral = (id === state.centralId);

        var lbl = document.createElement('div');
        lbl.className = 'ctx-label';
        lbl.textContent = isCentral ? '整張圖的結構' : '此分支的結構';
        menu.appendChild(lbl);

        function opt(name, label) {
            var cur = isCentral ? state.mapStructure : (n.structure || '__inherit');
            var d = document.createElement('div');
            d.className = 'ctx-item';
            var s = document.createElement('span');
            s.textContent = (cur === name ? '●\u2002' : '\u2003') + label;
            d.appendChild(s);
            d.addEventListener('click', function () {
                hideCtxMenu();
                setStructure(isCentral ? null : id, name === '__inherit' ? null : name);
            });
            menu.appendChild(d);
        }

        if (isCentral) opt('mindmap', STRUCT_LABELS['mindmap']);
        opt('logic-right', STRUCT_LABELS['logic-right']);
        opt('logic-left', STRUCT_LABELS['logic-left']);
        opt('org-down', STRUCT_LABELS['org-down']);
        opt('tree-right', STRUCT_LABELS['tree-right']);
        if (!isCentral) opt('__inherit', '繼承父層（清除覆寫）');

        var sepEl = document.createElement('div');
        sepEl.className = 'ctx-sep';
        menu.appendChild(sepEl);
        var back = document.createElement('div');
        back.className = 'ctx-item';
        var bs = document.createElement('span');
        bs.textContent = '↩ 返回';
        back.appendChild(bs);
        back.addEventListener('click', function () { showCtxMenu(x, y, id); });
        menu.appendChild(back);

        menu.classList.remove('hidden');
        var mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 200;
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        menu.style.left = Math.min(x, vw - mw - 8) + 'px';
        menu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    function showCtxMenu(x, y, id) {
        var n = node(id);
        if (!n) return;
        var menu = els.ctxMenu;
        menu.textContent = '';

        function item(label, kbd, fn, cls) {
            var d = document.createElement('div');
            d.className = 'ctx-item' + (cls ? ' ' + cls : '');
            var s1 = document.createElement('span');
            s1.textContent = label;
            d.appendChild(s1);
            if (kbd) {
                var s2 = document.createElement('span');
                s2.className = 'kbd';
                s2.textContent = kbd;
                d.appendChild(s2);
            }
            d.addEventListener('click', function () { hideCtxMenu(); fn(); });
            menu.appendChild(d);
        }
        function sep() {
            var d = document.createElement('div');
            d.className = 'ctx-sep';
            menu.appendChild(d);
        }

        /* 標註：只有編輯與刪除 */
        if (n.type === 'callout') {
            item('編輯文字', 'F2', function () { startEdit(id, null, true); });
            sep();
            item('刪除標註', 'Del', function () { removeNode(id); }, 'danger');
            menu.classList.remove('hidden');
            var mw0 = menu.offsetWidth || 200, mh0 = menu.offsetHeight || 120;
            var vw0 = window.innerWidth || 1200, vh0 = window.innerHeight || 800;
            menu.style.left = Math.min(x, vw0 - mw0 - 8) + 'px';
            menu.style.top = Math.min(y, vh0 - mh0 - 8) + 'px';
            return;
        }

        /* 概要主題：可編輯、可長子樹、整組移除 */
        if (n.type === 'summary') {
            item('編輯文字', 'F2', function () { startEdit(id, null, true); });
            item('新增子主題', 'Tab', function () { var nid = addChild(id); if (nid) startEdit(nid, null, true); });
            if (childrenOf(id).length) {
                item(n.collapsed ? '展開分支' : '摺疊分支', 'Ctrl+/', function () { toggleCollapse(id); });
            }
            item('建立關聯 →', '', function () { startLinking(id); });
            item('AI 產生子主題…', '', function () { openAiExpandModal(id); });
            sep();
            item('移除概要', 'Del', function () { removeNode(id); }, 'danger');
            menu.classList.remove('hidden');
            var mwS = menu.offsetWidth || 200, mhS = menu.offsetHeight || 160;
            var vwS = window.innerWidth || 1200, vhS = window.innerHeight || 800;
            menu.style.left = Math.min(x, vwS - mwS - 8) + 'px';
            menu.style.top = Math.min(y, vhS - mhS - 8) + 'px';
            return;
        }

        /* 多選：加入外框／概要、批次刪除 */
        if (state.selectedIds.length > 1 && state.selectedIds.indexOf(id) >= 0) {
            var pid0 = n.parentId, sameParent = !!pid0;
            for (var mi = 0; mi < state.selectedIds.length; mi++) {
                var mn = node(state.selectedIds[mi]);
                if (!mn || mn.parentId !== pid0 || mn.type !== 'topic') { sameParent = false; break; }
            }
            var selCnt = state.selectedIds.length;
            /* 外框：任意多選皆可（跨層級／不連續會自動分簇成數個框） */
            var selIdsB = state.selectedIds.slice();
            item('加入外框（' + selCnt + ' 個節點）', '', function () { addBoundary(selIdsB); });
            if (sameParent) {
                var sibsSel = rangeSibs(pid0, state.selectedIds[0]);
                var loI = Infinity, hiI = -1, missing = false;
                for (mi = 0; mi < state.selectedIds.length; mi++) {
                    var pos = -1;
                    for (var sj = 0; sj < sibsSel.length; sj++) if (sibsSel[sj].id === state.selectedIds[mi]) { pos = sj; break; }
                    if (pos < 0) { missing = true; break; }
                    if (pos < loI) loI = pos;
                    if (pos > hiI) hiI = pos;
                }
                if (!missing) {
                    var fromSel = sibsSel[loI].id, toSel = sibsSel[hiI].id;
                    var stSel = structureOf(node(fromSel));
                    if (stSel === 'logic-right' || stSel === 'logic-left') {
                        item('加入概要（' + selCnt + ' 個節點）', '', function () {
                            var tid = addSummary(pid0, fromSel, toSel);
                            if (tid) startEdit(tid, null, true);
                        });
                    }
                }
            }
            sep();
            item('刪除選取的 ' + selCnt + ' 個節點', 'Del', function () { removeNodes(state.selectedIds.slice()); }, 'danger');
            menu.classList.remove('hidden');
            var mwM = menu.offsetWidth || 220, mhM = menu.offsetHeight || 140;
            var vwM = window.innerWidth || 1200, vhM = window.innerHeight || 800;
            menu.style.left = Math.min(x, vwM - mwM - 8) + 'px';
            menu.style.top = Math.min(y, vhM - mhM - 8) + 'px';
            return;
        }

        item('新增子主題', 'Tab', function () { var nid = addChild(id); if (nid) startEdit(nid, null, true); });
        if (id !== state.centralId) {
            item('新增同層主題', 'Enter', function () { var nid = addSibling(id); if (nid) startEdit(nid, null, true); });
        }
        item('新增標註', '', function () { var cid = addCallout(id); if (cid) startEdit(cid, null, true); });
        item('建立關聯 →', '', function () { startLinking(id); });
        item('AI 產生子主題…', '', function () { openAiExpandModal(id); });
        if (n.parentId && n.type === 'topic') {
            item('加入外框', '', function () { addBoundary([id]); });
            var stMe = structureOf(n);
            if (stMe === 'logic-right' || stMe === 'logic-left') {
                item('加入概要', '', function () { var tid = addSummary(n.parentId, id, id); if (tid) startEdit(tid, null, true); });
            }
        }
        sep();
        item('超連結…', '', function () { openLinkModal(id); });
        item('備註…', '', function () { openNoteModal(id); });
        if (n.props && n.props.image) {
            item('更換圖片…', '', function () { pickFile(els.fileImageInput, function (f) { insertImage(id, f); }); });
            item('移除圖片', '', function () { removeImage(id); });
        } else {
            item('插入圖片…', '', function () { pickFile(els.fileImageInput, function (f) { insertImage(id, f); }); });
        }
        item('新增附檔…', '', function () { pickFile(els.fileAttachInput, function (f) { addAttachment(id, f); }); });
        if (n.props && Array.isArray(n.props.attachments) && n.props.attachments.length) {
            var attSub = n.props.attachments;
            for (var attI = 0; attI < attSub.length; attI++) {
                (function (a) {
                    item('　移除附檔：' + (a.fileName || ''), '', function () { removeAttachment(id, a.fileId); });
                })(attSub[attI]);
            }
        }
        item('編輯文字', 'F2', function () { startEdit(id, null, true); });
        if (childrenOf(id).length && id !== state.centralId) {
            item(n.collapsed ? '展開分支' : '摺疊分支', 'Ctrl+/', function () { toggleCollapse(id); });
        }

        sep();
        var curSt = (id === state.centralId) ? state.mapStructure : structureOf(n);
        item('變更結構…（' + (STRUCT_LABELS[curSt] || curSt) + '）', '', function () {
            showStructureMenu(x, y, id);
        });
        if (n.type === 'topic' && n.parentId) {
            if (isPinned(n)) {
                item('取消固定位置（回自動排列）', '', function () { clearNodePos(id); });
            }
            item('拆離成浮動主題', '', function () { detachToFloating(id, n.cx, n.cy); });
        }

        if (id !== state.centralId) {
            sep();
            var lbl = document.createElement('div');
            lbl.className = 'ctx-label';
            lbl.textContent = '分支顏色';
            menu.appendChild(lbl);
            var row = document.createElement('div');
            row.className = 'ctx-swatches';
            for (var i = 0; i < PALETTE.length; i++) {
                (function (c) {
                    var sw = document.createElement('div');
                    sw.className = 'swatch';
                    sw.style.background = c;
                    sw.title = c;
                    sw.addEventListener('click', function () { hideCtxMenu(); setColor(id, c); });
                    row.appendChild(sw);
                })(PALETTE[i]);
            }
            var rs = document.createElement('div');
            rs.className = 'swatch reset';
            rs.title = '還原預設顏色';
            rs.addEventListener('click', function () { hideCtxMenu(); setColor(id, null); });
            row.appendChild(rs);
            menu.appendChild(row);

            sep();
            if (n.type === 'floating' && !n.parentId) {
                item('收回中心主題', '', function () { applyReparent(id, state.centralId, 'child'); });
            }
            item('刪除節點', 'Del', function () { removeNode(id); }, 'danger');
        }

        menu.classList.remove('hidden');
        var mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 200;
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        menu.style.left = Math.min(x, vw - mw - 8) + 'px';
        menu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    /* ---------------- 拖曳搬移 ---------------- */
    /* 世界座標命中最上層節點（依繪製順序後畫者優先；含概要主題與標註）。
       用途：指標捕捉等因素讓 dblclick 的 e.target 落在 svg 上時的座標後援。 */
    function nodeAtPoint(worldX, worldY) {
        var idx = buildChildIndex();
        var hit = null;
        function test(n) {
            if (!n || n.cx == null) return;
            if (worldX >= n.cx - n.w / 2 && worldX <= n.cx + n.w / 2 &&
                worldY >= n.cy - n.h / 2 && worldY <= n.cy + n.h / 2) hit = n;
        }
        function walk(id) {
            var n = node(id);
            if (!n) return;
            test(n);
            if (n.collapsed) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(state.centralId);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) walk(fls[fi].id);
        for (var si = 0; si < state.summaries.length; si++) {
            var sp = node(state.summaries[si].parentId);
            if (!sp || sp.collapsed) continue;
            walk(state.summaries[si].topicId);
        }
        for (var ck in state.nodes) {
            var cn = state.nodes[ck];
            if (cn.type !== 'callout') continue;
            var host = node(cn.parentId);
            if (host && host.cx != null && cn.cx != null) test(cn);
        }
        return hit;
    }

    function hitTestDrop(worldX, worldY, dragId) {
        var best = null;
        var idx = buildChildIndex();
        function walk(id) {
            var n = node(id);
            if (!n || n.cx == null) return;
            if (id !== dragId && !isDescendant(dragId, id)) {
                var padX = 14, padY = 8;
                if (worldX >= n.cx - n.w / 2 - padX && worldX <= n.cx + n.w / 2 + padX &&
                    worldY >= n.cy - n.h / 2 - padY && worldY <= n.cy + n.h / 2 + padY) {
                    best = n;   /* 之後走訪到的較深節點覆蓋前者 */
                }
            }
            if (n.collapsed || id === dragId) return;
            var kids = idx[id] || [];
            for (var i = 0; i < kids.length; i++) walk(kids[i].id);
        }
        walk(state.centralId);
        var fls = floatingRoots();
        for (var fi = 0; fi < fls.length; fi++) walk(fls[fi].id);
        if (!best) return null;

        var zone = 'child';
        if (best.id !== state.centralId) {
            var relY = (worldY - (best.cy - best.h / 2)) / best.h;
            if (relY < 0.28) zone = 'before';
            else if (relY > 0.72) zone = 'after';
        }
        return { id: best.id, zone: zone, worldX: worldX };
    }

    function drawDropHint(tgt) {
        var hint = els.dropHint;
        hint.textContent = '';
        if (!tgt) return;
        var n = node(tgt.id);
        if (!n) return;
        hint.appendChild(mk('rect', {
            x: r2(n.cx - n.w / 2 - 5), y: r2(n.cy - n.h / 2 - 5),
            width: r2(n.w + 10), height: r2(n.h + 10),
            rx: 9, fill: 'rgba(76,154,255,0.10)',
            stroke: SEL_COLOR, 'stroke-width': 1.5, 'stroke-dasharray': '5 4'
        }));
        if (tgt.zone === 'before' || tgt.zone === 'after') {
            var y = (tgt.zone === 'before') ? (n.cy - n.h / 2 - 8) : (n.cy + n.h / 2 + 8);
            hint.appendChild(mk('path', {
                d: 'M ' + r2(n.cx - n.w / 2) + ' ' + r2(y) + ' H ' + r2(n.cx + n.w / 2),
                stroke: SEL_COLOR, 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none'
            }));
        }
    }

    /* 拖到空白處的提示：游標處虛線框＋動作說明 */
    function drawFreeHint(wx, wy, n, label) {
        var hint = els.dropHint;
        hint.textContent = '';
        var w0 = (n && n.w) || 80, h0 = (n && n.h) || 32;
        hint.appendChild(mk('rect', {
            x: r2(wx - w0 / 2), y: r2(wy - h0 / 2),
            width: r2(w0), height: r2(h0),
            rx: 8, fill: 'rgba(76,154,255,0.08)',
            stroke: SEL_COLOR, 'stroke-width': 1.5, 'stroke-dasharray': '5 4'
        }));
        hint.appendChild(mk('text', {
            x: r2(wx), y: r2(wy - h0 / 2 - 8), 'text-anchor': 'middle',
            'font-family': FONT_FAMILY, 'font-size': 11, fill: SEL_COLOR
        }, label));
    }

    function cancelDrag() {
        if (!state.drag) return;
        state.drag = null;
        els.dragGhost.classList.add('hidden');
        if (els.dropHint) els.dropHint.textContent = '';
    }

    /* ---------------- 事件繫結 ---------------- */
    /* 自製雙擊偵測：第一下點擊會 select→render 銷毀原目標元素，
       瀏覽器的 dblclick 合成要求兩次 click 落在同一元素，因此永遠不會發出。
       改在 pointerdown 層自行判定（400ms 內、位移 <6px、同一目標鍵）。 */
    var _lastDown = { t: 0, x: 0, y: 0, key: '' };
    var _dblHandledAt = 0;
    function quickSecond(key, e) {
        var now = Date.now();
        var hit = (now - _lastDown.t < 400) &&
                  Math.abs(e.clientX - _lastDown.x) < 6 &&
                  Math.abs(e.clientY - _lastDown.y) < 6 &&
                  _lastDown.key === key;
        _lastDown = { t: now, x: e.clientX, y: e.clientY, key: key };
        return hit;
    }

    function onPointerDown(e) {
        if (e.button !== 0 && e.button !== undefined) {
            if (e.button !== 0) return;
        }

        if (state.pitch) {
            var rect0 = els.svg.getBoundingClientRect();
            if (e.clientX - rect0.left < rect0.width / 2) pitchPrev();
            else pitchNext();
            e.preventDefault();
            return;
        }

        hideCtxMenu();

        /* 主題連結點選模式：這一下用來選連結目標 */
        if (state.picking) {
            var pg = e.target.closest ? e.target.closest('.mm-node') : null;
            var forId = state.picking.forId;
            cancelPicking();
            if (pg) {
                var tgtId = pg.getAttribute('data-id');
                if (tgtId === forId) toast('不能連到自己');
                else setProps(forId, { link: { type: 'topic', value: tgtId } });
            }
            e.preventDefault();
            return;
        }

        /* 連線模式：這一下點擊用來選目標（點空白＝取消） */
        if (state.linking) {
            var lg = e.target.closest ? e.target.closest('.mm-node') : null;
            var fromId = state.linking.fromId;
            cancelLinking();
            if (lg) {
                var toId = lg.getAttribute('data-id');
                var newRel = addRelation(fromId, toId);
                if (!newRel && fromId !== toId) toast('這兩個主題已有相同方向的關聯');
            }
            e.preventDefault();
            return;
        }

        /* 關聯線中點控制柄：開始調整彎曲 */
        var hEl = e.target.closest ? e.target.closest('[data-relhandle]') : null;
        if (hEl) {
            _lastDown.key = '';
            state.drag = { kind: 'relbend', relId: hEl.getAttribute('data-relhandle'), startX: e.clientX, startY: e.clientY, active: false };
            e.preventDefault();
            return;
        }

        /* 圖片：點擊開新分頁看原圖 */
        var imgEl = e.target.closest ? e.target.closest('[data-image-for]') : null;
        if (imgEl) {
            _lastDown.key = '';
            var imgFor = imgEl.getAttribute('data-image-for');
            select(imgFor);
            var imR = node(imgFor) && node(imgFor)._regions && node(imgFor)._regions.image;
            if (imR) { try { window.open(fileUrl(imR.fileId), '_blank', 'noopener'); } catch (e2) { } }
            e.preventDefault();
            return;
        }

        /* 附檔：點擊下載 */
        var attEl = e.target.closest ? e.target.closest('[data-attach]') : null;
        if (attEl) {
            _lastDown.key = '';
            select(attEl.getAttribute('data-attach-for'));
            downloadAttachment(attEl.getAttribute('data-attach'));
            e.preventDefault();
            return;
        }

        /* 連結／備註小圖示 */
        var iconEl = e.target.closest ? e.target.closest('[data-icon]') : null;
        if (iconEl) {
            _lastDown.key = '';
            var iconFor = iconEl.getAttribute('data-icon-for');
            var iconKind = iconEl.getAttribute('data-icon');
            select(iconFor);
            if (iconKind === 'link') followLink(iconFor);
            else openNoteModal(iconFor);
            e.preventDefault();
            return;
        }

        var toggleEl = e.target.closest ? e.target.closest('[data-toggle]') : null;
        if (toggleEl) {
            _lastDown.key = '';
            toggleCollapse(toggleEl.getAttribute('data-toggle'));
            e.preventDefault();
            return;
        }

        var g = e.target.closest ? e.target.closest('.mm-node') : null;
        var sumEl = e.target.closest ? e.target.closest('[data-summary]') : null;
        var bEl = e.target.closest ? e.target.closest('[data-boundary]') : null;
        var relEl = e.target.closest ? e.target.closest('[data-rel]') : null;
        if (g) {
            var id = g.getAttribute('data-id');
            if (state.editingId && state.editingId !== id) commitEdit(true);
            if (e.ctrlKey || e.metaKey) {          /* Ctrl＋點：有連結→跳轉；否則 toggle 多選 */
                var nl = node(id);
                if (nl && nl.props && nl.props.link && nl.props.link.value) {
                    select(id);
                    followLink(id);
                } else {
                    toggleSelect(id);
                }
                e.preventDefault();
                return;
            }
            if (e.shiftKey && state.selectedId && state.selectedId !== id) {   /* Shift＝連續兄弟區間 */
                rangeSelect(state.selectedId, id);
                e.preventDefault();
                return;
            }
            if (quickSecond('n:' + id, e)) {
                e.preventDefault();
                _dblHandledAt = Date.now();
                select(id);
                startEdit(id, null, true);
                return;
            }
            select(id);
            state.drag = { id: id, startX: e.clientX, startY: e.clientY, active: false, target: null };
        } else if (sumEl) {
            _lastDown.key = '';
            if (state.editingId || state.editingRelId || state.editingBoundaryId) commitEdit(true);
            var sid1 = sumEl.getAttribute('data-summary');
            for (var qi = 0; qi < state.summaries.length; qi++) {
                if (state.summaries[qi].summaryId === sid1) { select(state.summaries[qi].topicId); break; }
            }
        } else if (bEl) {
            _lastDown.key = '';
            if (state.editingId || state.editingRelId || state.editingBoundaryId) commitEdit(true);
            selectBoundary(bEl.getAttribute('data-boundary'));
        } else if (relEl) {
            if (state.editingId || state.editingRelId || state.editingBoundaryId) commitEdit(true);
            var relId0 = relEl.getAttribute('data-rel');
            if (quickSecond('rel:' + relId0, e)) {
                e.preventDefault();
                _dblHandledAt = Date.now();
                startRelEdit(relId0);
                return;
            }
            selectRelation(relId0);
        } else {
            if (state.editingId || state.editingRelId || state.editingBoundaryId) commitEdit(true);
            if (quickSecond('empty', e)) {
                e.preventDefault();
                _dblHandledAt = Date.now();
                var wDbl = screenToWorld(e.clientX, e.clientY);
                var nidDbl = addFloating(wDbl.x, wDbl.y);
                if (nidDbl) startEdit(nidDbl, null, true);
                return;
            }
            if (state.selectedId || state.selectedIds.length || state.selectedRelId || state.selectedBoundaryId) {
                state.selectedId = null;
                state.selectedIds = [];
                state.selectedRelId = null;
                state.selectedBoundaryId = null;
                render();                           /* 點空白＝清空選取 */
            }
            state.pan = { startX: e.clientX, startY: e.clientY, panX0: state.panX, panY0: state.panY };
        }
        /* 注意：這裡「不可」呼叫 e.preventDefault() 或 setPointerCapture()——
           前者依 Pointer Events 規範會抑制後續 click/dblclick 相容事件；
           後者會把 click/dblclick 的目標重導到捕捉元素（svg），讓雙擊命中不到節點。
           指標捕捉改在拖曳「真正啟動」的那一刻（onPointerMove 位移超過門檻時）才設定。 */
    }

    function onPointerMove(e) {
        if (state.pan) {
            if (!state.pan.cap) {
                state.pan.cap = true;
                try { els.svg.setPointerCapture(e.pointerId); } catch (err) { }
            }
            state.panX = state.pan.panX0 + (e.clientX - state.pan.startX);
            state.panY = state.pan.panY0 + (e.clientY - state.pan.startY);
            setViewport();
            return;
        }

        /* 連線模式：畫「來源 → 游標」預覽虛線 */
        if (state.linking) {
            var lw = screenToWorld(e.clientX, e.clientY);
            var src = node(state.linking.fromId);
            if (src && src.cx != null && els.dropHint) {
                els.dropHint.textContent = '';
                els.dropHint.appendChild(mk('path', {
                    d: 'M' + r2(src.cx) + ' ' + r2(src.cy) + ' L ' + r2(lw.x) + ' ' + r2(lw.y),
                    stroke: REL_COLOR, 'stroke-width': 2, 'stroke-dasharray': '6 5', fill: 'none'
                }));
            }
            return;
        }

        if (!state.drag) return;
        var d = state.drag;

        /* 關聯線彎曲拖曳（即時預覽） */
        if (d.kind === 'relbend') {
            if (!d.active) {
                if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 3) return;
                d.active = true;
                try { els.svg.setPointerCapture(e.pointerId); } catch (err) { }
            }
            var bw = screenToWorld(e.clientX, e.clientY);
            d.mx = bw.x; d.my = bw.y;
            var rr = findRel(d.relId);
            if (rr) { rr.__pv = { mx: bw.x, my: bw.y }; render(); }
            return;
        }

        if (!d.active) {
            if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 6) return;
            if (d.id === state.centralId) return;    /* 中心主題不可拖曳 */
            d.active = true;
            try { els.svg.setPointerCapture(e.pointerId); } catch (err) { }
            var n = node(d.id);
            els.dragGhost.textContent = (n && n.text) || '';
            els.dragGhost.classList.remove('hidden');
        }
        els.dragGhost.style.left = (e.clientX + 12) + 'px';
        els.dragGhost.style.top = (e.clientY + 12) + 'px';
        var w = screenToWorld(e.clientX, e.clientY);
        d.world = w;
        var dn = node(d.id);
        if (dn && dn.type === 'callout') {                   /* 標註：拖曳＝調整 offset，不參與掛接 */
            d.target = null;
            drawFreeHint(w.x, w.y, dn, '放開＝移動標註');
            return;
        }
        if (dn && dn.type === 'summary') {           /* 概要主題：位置由大括號區間決定 */
            d.target = null;
            drawFreeHint(w.x, w.y, dn, '概要主題的位置由區間決定，不能拖曳');
            return;
        }
        d.target = hitTestDrop(w.x, w.y, d.id);
        if (d.target) {
            drawDropHint(d.target);
        } else if (dn && dn.type === 'floating' && !dn.parentId) {
            drawFreeHint(w.x, w.y, dn, '放開＝移動浮動主題');
        } else {
            drawFreeHint(w.x, w.y, dn, '放開＝固定在此位置');
        }
    }

    function onPointerUp(e) {
        if (state.pan) { state.pan = null; return; }
        if (!state.drag) return;
        var d = state.drag;
        state.drag = null;
        els.dragGhost.classList.add('hidden');
        if (els.dropHint) els.dropHint.textContent = '';

        if (d.kind === 'relbend') {
            var rb = findRel(d.relId);
            if (rb) delete rb.__pv;
            if (d.active && d.mx != null) setRelationBend(d.relId, d.mx, d.my);
            else render();
            return;
        }

        if (!d.active) return;

        var wpt = d.world || screenToWorld(e.clientX, e.clientY);
        var dn = node(d.id);
        if (dn && dn.type === 'callout') {
            var host = node(dn.parentId);
            if (host && host.cx != null) setCalloutOffset(d.id, wpt.x - host.cx, wpt.y - host.cy);
            return;
        }
        if (dn && dn.type === 'summary') { render(); return; }
        if (d.target) {
            applyReparent(d.id, d.target.id, d.target.zone, d.target.worldX);
            return;
        }
        if (dn && dn.type === 'floating' && !dn.parentId) {
            setFloatingPos(d.id, wpt.x, wpt.y);
            return;
        }
        if (dn && d.id !== state.centralId) {
            pinNodeAt(d.id, wpt.x, wpt.y);   /* 拖到空白＝固定在此位置（仍掛在原父之下，連線不斷） */
        }
    }

    function onWheel(e) {
        if (state.pitch) { e.preventDefault(); return; }   /* 演示模式：鎖縮放與平移 */
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
        } else {
            if (e.shiftKey) state.panX -= e.deltaY;
            else { state.panX -= e.deltaX; state.panY -= e.deltaY; }
            setViewport();
        }
    }

    function onDblClick(e) {
        if (state.pitch) return;
        if (_dblHandledAt && Date.now() - _dblHandledAt < 500) { _dblHandledAt = 0; return; }   /* 自製偵測已處理，吃掉這次原生合成 */
        var relEl = e.target.closest ? e.target.closest('[data-rel]') : null;
        if (relEl) { startRelEdit(relEl.getAttribute('data-rel')); return; }
        var wpt = screenToWorld(e.clientX, e.clientY);
        var g = e.target.closest ? e.target.closest('.mm-node') : null;
        var n = g ? node(g.getAttribute('data-id')) : nodeAtPoint(wpt.x, wpt.y);
        if (n) {
            startEdit(n.id, null, true);
            return;
        }
        var nid = addFloating(wpt.x, wpt.y);
        if (nid) startEdit(nid, null, true);
    }

    function onContextMenu(e) {
        e.preventDefault();
        if (state.pitch) return;
        var g = e.target.closest ? e.target.closest('.mm-node') : null;
        var sumEl = e.target.closest ? e.target.closest('[data-summary]') : null;
        var bEl = e.target.closest ? e.target.closest('[data-boundary]') : null;
        var relEl = e.target.closest ? e.target.closest('[data-rel]') : null;
        if (g) {
            var id = g.getAttribute('data-id');
            setPrimary(id);                         /* 右鍵不打散既有多選 */
            showCtxMenu(e.clientX, e.clientY, id);
        } else if (sumEl) {
            var sid0 = sumEl.getAttribute('data-summary');
            for (var qi = 0; qi < state.summaries.length; qi++) {
                if (state.summaries[qi].summaryId === sid0) {
                    select(state.summaries[qi].topicId);
                    showCtxMenu(e.clientX, e.clientY, state.summaries[qi].topicId);
                    return;
                }
            }
        } else if (bEl) {
            var bid0 = bEl.getAttribute('data-boundary');
            selectBoundary(bid0);
            showBoundaryMenu(e.clientX, e.clientY, bid0);
        } else if (relEl) {
            var rid0 = relEl.getAttribute('data-rel');
            selectRelation(rid0);
            showRelMenu(e.clientX, e.clientY, rid0);
        } else {
            var w0 = screenToWorld(e.clientX, e.clientY);
            showCanvasMenu(e.clientX, e.clientY, w0.x, w0.y);
        }
    }

    function navigate(key) {
        var n = node(state.selectedId);
        if (!n) return;
        var idx = buildChildIndex();
        var st = structureOf(n);

        function kidsOf(base) { return base.collapsed ? [] : (idx[base.id] || []); }
        function firstChild(base, side) {
            var ks = kidsOf(base);
            if (base.id === state.centralId && structureOf(base) === 'mindmap') {
                ks = ks.filter(function (x) { return sideOf(x) === (side || 'R'); });
            }
            return ks.length ? ks[0].id : null;
        }
        function sibStep(delta) {
            if (!n.parentId) return;
            var sibs = idx[n.parentId] || [];
            var p = node(n.parentId);
            if (n.parentId === state.centralId && p && structureOf(p) === 'mindmap') {
                sibs = sibs.filter(function (x) { return sideOf(x) === sideOf(n); });
            }
            var i = -1;
            for (var j = 0; j < sibs.length; j++) if (sibs[j].id === n.id) { i = j; break; }
            var k = i + delta;
            if (k >= 0 && k < sibs.length) select(sibs[k].id);
        }
        function toParent() { if (n.parentId) select(n.parentId); }
        function toChild(side) { var c = firstChild(n, side); if (c) select(c); }

        /* 中心主題（心智圖）：←→ 進入左右第一個分支 */
        if (n.id === state.centralId && structureOf(n) === 'mindmap') {
            if (key === 'ArrowRight') toChild('R');
            else if (key === 'ArrowLeft') toChild('L');
            return;
        }

        if (st === 'org-down') {
            if (key === 'ArrowDown') toChild(null);
            else if (key === 'ArrowUp') toParent();
            else if (key === 'ArrowLeft') sibStep(-1);
            else if (key === 'ArrowRight') sibStep(1);
            return;
        }

        if (st === 'tree-right') {
            if (key === 'ArrowRight') { toChild(null); return; }
            if (key === 'ArrowLeft') { toParent(); return; }
            /* ↑↓ ＝同一棵樹的 DFS 上／下一個可見節點 */
            var root = n, guard = 0;
            while (root.parentId && node(root.parentId) && guard++ < 10000) root = node(root.parentId);
            var flat = [];
            (function w(id) {
                var m = node(id);
                if (!m) return;
                flat.push(m.id);
                if (m.collapsed) return;
                var ks = idx[id] || [];
                for (var q = 0; q < ks.length; q++) w(ks[q].id);
            })(root.id);
            var pos = flat.indexOf(n.id);
            var np = pos + (key === 'ArrowDown' ? 1 : -1);
            if (np >= 0 && np < flat.length) select(flat[np]);
            return;
        }

        /* logic-left / logic-right（含 mindmap 展開後的分支） */
        if (key === 'ArrowUp') { sibStep(-1); return; }
        if (key === 'ArrowDown') { sibStep(1); return; }
        var toward = (key === 'ArrowRight') ? 1 : -1;
        var dir = (st === 'logic-left') ? -1 : 1;
        if (dir === toward) toChild(null);
        else toParent();
    }

    function onKeyDown(e) {
        var key = e.key;

        if (state.pitch) {
            if (key === 'ArrowRight' || key === ' ' || key === 'Spacebar' || key === 'PageDown') { e.preventDefault(); pitchNext(); }
            else if (key === 'ArrowLeft' || key === 'PageUp') { e.preventDefault(); pitchPrev(); }
            else if (key === 'Home') { e.preventDefault(); goSlide(0); }
            else if (key === 'End' || key === 'Escape') { e.preventDefault(); exitPitch(); }
            return;   /* 演示中不處理任何編輯類快捷鍵 */
        }

        if (state.drag) {
            if (key === 'Escape') cancelDrag();
            return;
        }

        if (state.linking) {
            if (key === 'Escape') { e.preventDefault(); cancelLinking(); }
            return;
        }

        if (state.picking) {
            if (key === 'Escape') { e.preventDefault(); cancelPicking(); }
            return;
        }

        var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
        var isEditorTarget = (e.target === els.editor);

        if (isEditorTarget) {
            if (key === 'Escape') { e.preventDefault(); commitEdit(false); }
            else if (key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(true); }
            else if (key === 'Tab') {
                e.preventDefault();
                var cur = state.editingId;
                commitEdit(true);
                if (cur) { var nid = addChild(cur); if (nid) startEdit(nid, null, true); }
            }
            return;
        }

        if (tag === 'input' || tag === 'textarea') {
            if (key === 'Escape') {
                if (state.ai) { e.preventDefault(); closeAiModal(); return; }
                if (els.linkModal && !els.linkModal.classList.contains('hidden')) { e.preventDefault(); closeLinkModal(); return; }
                if (els.noteModal && !els.noteModal.classList.contains('hidden')) { e.preventDefault(); closeNoteModal(); return; }
            }
            if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 's') { e.preventDefault(); commitTitle(); saveMap(); }
            if (key === 'Enter' && e.target === els.mapTitle) { e.target.blur(); }
            return;
        }

        if (e.ctrlKey || e.metaKey) {
            var lk = key.toLowerCase();
            if (lk === 's') { e.preventDefault(); saveMap(); return; }
            if (lk === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
            if (lk === 'y') { e.preventDefault(); redo(); return; }
            if (key === '/') { e.preventDefault(); if (state.selectedId) toggleCollapse(state.selectedId); return; }
            if (key === '0') { e.preventDefault(); fitView(); return; }
            return;
        }

        if (state.selectedBoundaryId) {
            if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); removeBoundary(state.selectedBoundaryId); return; }
            if (key === 'F2') { e.preventDefault(); startBoundaryEdit(state.selectedBoundaryId); return; }
            if (key === 'Escape') { e.preventDefault(); state.selectedBoundaryId = null; render(); return; }
        }

        if (state.selectedRelId) {
            if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); removeRelation(state.selectedRelId); return; }
            if (key === 'F2') { e.preventDefault(); startRelEdit(state.selectedRelId); return; }
            if (key === 'Escape') { e.preventDefault(); state.selectedRelId = null; render(); return; }
        }

        var sel = state.selectedId;
        if (!sel || !node(sel)) return;

        if (key === 'Tab') { e.preventDefault(); var a = addChild(sel); if (a) startEdit(a, null, true); return; }
        if (key === 'Enter') { e.preventDefault(); var b = addSibling(sel); if (b) startEdit(b, null, true); return; }
        if (key === 'F2' || key === ' ') { e.preventDefault(); startEdit(sel, null, true); return; }
        if (key === 'Delete' || key === 'Backspace') {
            e.preventDefault();
            if (state.selectedIds.length > 1) removeNodes(state.selectedIds.slice());
            else removeNode(sel);
            return;
        }
        if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
            e.preventDefault(); navigate(key); return;
        }
        if (key === 'Escape') { hideCtxMenu(); return; }
        if (key.length === 1 && !e.altKey) {
            e.preventDefault();
            startEdit(sel, key, false);
        }
    }

    /* ---------------- 匯出 PNG ---------------- */
    /* ---------------- P9：匯出（PNG／SVG，涵蓋全部圖層） ---------------- */

    /* 把單一 <img>/<image> 來源轉成 dataURL（P6 附圖走 getfile，網址式圖片走原樣）。
       地雷：SVG <image> 若保留伺服器相對網址，匯出檔案脫離頁面環境後會失連，故一律內嵌 dataURL。 */
    function toDataUrl(url) {
        return fetch(url).then(function (r) {
            if (!r.ok && typeof r.ok !== 'undefined') throw new Error('讀取圖片失敗');
            return r.blob();
        }).then(function (blob) {
            return new Promise(function (resolve, reject) {
                var fr = new FileReader();
                fr.onload = function () { resolve(fr.result); };
                fr.onerror = function () { reject(new Error('圖片轉檔失敗')); };
                fr.readAsDataURL(blob);
            });
        });
    }

    /* 組出可獨立使用的匯出 SVG：boundary→link→summary→rel→node 五層，
       跳過 overlayLayer（選取框／控制柄不該出現在匯出檔）。 */
    function buildExportSvg() {
        var bb = contentBBox();
        var pad = 30;
        var x = bb.x - pad, y = bb.y - pad, w = bb.w + pad * 2, h = bb.h + pad * 2;

        var tmp = mk('svg', {
            width: Math.ceil(w), height: Math.ceil(h),
            viewBox: r2(x) + ' ' + r2(y) + ' ' + r2(w) + ' ' + r2(h)
        });
        tmp.appendChild(mk('rect', { x: r2(x), y: r2(y), width: r2(w), height: r2(h), fill: (themeOf().canvas || BG_COLOR) }));

        var layerIds = ['boundaryLayer', 'linkLayer', 'summaryLayer', 'relLayer', 'nodeLayer'];
        var clones = [];
        for (var i = 0; i < layerIds.length; i++) {
            var src = els[layerIds[i]];
            clones.push(src ? src.cloneNode(true) : mk('g', {}));
        }
        var nodeClone = clones[clones.length - 1];
        var toggles = nodeClone.querySelectorAll('.mm-toggle');
        for (i = toggles.length - 1; i >= 0; i--) {
            if (!/\bon\b/.test(toggles[i].getAttribute('class') || '')) {
                toggles[i].parentNode.removeChild(toggles[i]);
            }
        }
        for (i = 0; i < clones.length; i++) tmp.appendChild(clones[i]);

        /* 節點圖片：href 換成 dataURL，避免匯出檔脫離網頁環境後失連 */
        var imgs = nodeClone.querySelectorAll('image');
        var jobs = [];
        for (i = 0; i < imgs.length; i++) {
            (function (im) {
                var href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
                if (!href) return;
                jobs.push(toDataUrl(href).then(function (durl) {
                    im.setAttribute('href', durl);
                    im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', durl);
                }).catch(function () { /* 單張圖片失敗不影響其餘匯出內容 */ }));
            })(imgs[i]);
        }

        return Promise.all(jobs).then(function () {
            var xml;
            try { xml = new XMLSerializer().serializeToString(tmp); }
            catch (e) { throw new Error('此瀏覽器不支援匯出'); }
            return { xml: xml, w: w, h: h };
        });
    }

    function downloadBlob(blob, filename) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }

    function exportSVG() {
        if (!node(state.centralId)) return Promise.resolve();
        return buildExportSvg().then(function (res) {
            var blob = new Blob([res.xml], { type: 'image/svg+xml;charset=utf-8' });
            downloadBlob(blob, (state.title || '心智圖') + '.svg');
            toast('已匯出 SVG');
        }).catch(function (e) { toast('匯出失敗：' + e.message, true); });
    }

    function exportPNG() {
        if (!node(state.centralId)) return;
        buildExportSvg().then(function (res) {
            var blob = new Blob([res.xml], { type: 'image/svg+xml;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () {
                try {
                    var scale = 2;
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.ceil(res.w * scale);
                    canvas.height = Math.ceil(res.h * scale);
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    URL.revokeObjectURL(url);
                    canvas.toBlob(function (png) {
                        if (!png) { toast('匯出失敗', true); return; }
                        downloadBlob(png, (state.title || '心智圖') + '.png');
                        toast('已匯出 PNG');
                    }, 'image/png');
                } catch (e2) { toast('匯出失敗：' + e2.message, true); }
            };
            img.onerror = function () { URL.revokeObjectURL(url); toast('匯出失敗', true); };
            img.src = url;
        }).catch(function (e) { toast('匯出失敗：' + e.message, true); });
    }

    /* ---------------- 介面小工具 ---------------- */
    var toastTimer = null;
    function toast(msg, isErr) {
        var t = els.toast;
        if (!t) return;
        t.textContent = msg;
        t.className = 'show' + (isErr ? ' err' : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.className = ''; }, 2200);
    }

    function pad2(v) { return v < 10 ? '0' + v : '' + v; }

    function updateSaveUI(mode) {
        var s = els.saveState;
        if (!s) return;
        if (mode === 'saving' || state.saving) {
            s.textContent = '儲存中…';
            s.className = '';
        } else if (state.dirty) {
            s.textContent = '● 未儲存';
            s.className = 'dirty';
        } else if (state.lastSaved) {
            s.textContent = '已儲存 ' + pad2(state.lastSaved.getHours()) + ':' + pad2(state.lastSaved.getMinutes());
            s.className = '';
        } else {
            s.textContent = '';
            s.className = '';
        }
        if (els.btnUndo) els.btnUndo.disabled = !state.undoStack.length;
        if (els.btnRedo) els.btnRedo.disabled = !state.redoStack.length;
    }

    function updateStatus() {
        if (els.stNodes) {
            var cnt = 0;
            for (var k in state.nodes) cnt++;
            els.stNodes.textContent = '節點 ' + cnt;
        }
        if (els.stZoom) els.stZoom.textContent = Math.round(state.scale * 100) + '%';
    }

    /* 固定式側欄：使用者手動開合，狀態記在 localStorage */
    function setDrawerOpen(open) {
        if (!els.drawer) return;
        if (open) {
            els.drawer.classList.remove('closed');
            refreshMapList();
        } else {
            els.drawer.classList.add('closed');
        }
        try { localStorage.setItem('mm.drawerOpen', open ? '1' : '0'); } catch (e) { }
    }
    function openDrawer() { setDrawerOpen(true); }
    function closeDrawer() { setDrawerOpen(false); }

    function commitTitle() {
        if (!els.mapTitle) return;
        var t = els.mapTitle.value.trim() || '未命名心智圖';
        els.mapTitle.value = t;
        if (t !== state.title) {
            state.title = t;
            markDirty();
        }
    }

    /* ---------------- 初始化 ---------------- */
    function cacheEls() {
        els.stage = $('stage');
        els.svg = $('svg');
        els.viewport = $('viewport');
        els.boundaryLayer = $('boundaryLayer');
        els.linkLayer = $('linkLayer');
        els.summaryLayer = $('summaryLayer');
        els.relLayer = $('relLayer');
        els.nodeLayer = $('nodeLayer');
        els.overlayLayer = $('overlayLayer');
        els.svgDefs = $('svgDefs');
        els.editor = $('editor');
        els.dragGhost = $('dragGhost');
        els.ctxMenu = $('ctxMenu');
        els.mapTitle = $('mapTitle');
        els.saveState = $('saveState');
        els.zoomLabel = $('zoomLabel');
        els.stNodes = $('stNodes');
        els.stZoom = $('stZoom');
        els.drawer = $('drawer');
        els.mapList = $('mapList');
        els.toast = $('toast');
        els.btnUndo = $('btnUndo');
        els.btnRedo = $('btnRedo');
        els.sheetBar = $('sheetBar');
        els.sheetTabs = $('sheetTabs');
        els.btnAddSheet = $('btnAddSheet');
        els.stage = $('stage');
        els.stylePanel = $('stylePanel');
        els.btnStylePanel = $('btnStylePanel');
        els.spTheme = $('spTheme');
        els.spStructure = $('spStructure');
        els.spShapes = $('spShapes');
        els.spFills = $('spFills');
        els.spFillHex = $('spFillHex');
        els.spBorderW = $('spBorderW');
        els.spBorderDash = $('spBorderDash');
        els.spFontMinus = $('spFontMinus');
        els.spFontVal = $('spFontVal');
        els.spFontPlus = $('spFontPlus');
        els.spBold = $('spBold');
        els.spItalic = $('spItalic');
        els.spFixedW = $('spFixedW');
        els.spFixedWVal = $('spFixedWVal');
        els.spMarkers = $('spMarkers');
        els.linkModal = $('linkModal');
        els.lmTypeUrl = $('lmTypeUrl');
        els.lmTypeTopic = $('lmTypeTopic');
        els.lmUrlRow = $('lmUrlRow');
        els.lmTopicRow = $('lmTopicRow');
        els.lmValue = $('lmValue');
        els.lmTopicName = $('lmTopicName');
        els.lmOk = $('lmOk');
        els.lmRemove = $('lmRemove');
        els.lmCancel = $('lmCancel');
        els.noteModal = $('noteModal');
        els.nmText = $('nmText');
        els.nmOk = $('nmOk');
        els.nmRemove = $('nmRemove');
        els.nmCancel = $('nmCancel');
        els.fileImageInput = $('fileImageInput');
        els.fileAttachInput = $('fileAttachInput');
        els.pitchBar = $('pitchBar');
        els.pitchTitle = $('pitchTitle');
        els.pitchIdx = $('pitchIdx');
        els.pitchPrev = $('pitchPrev');
        els.pitchNext = $('pitchNext');
        els.pitchClose = $('pitchClose');
        els.btnPitch = $('btnPitch');
        els.btnAiGen = $('btnAiGen');
        els.btnExportSvg = $('btnExportSvg');
        els.aiModal = $('aiModal');
        els.aiTitle = $('aiTitle');
        els.aiCountRow = $('aiCountRow');
        els.aiCount = $('aiCount');
        els.aiExtra = $('aiExtra');
        els.aiStatus = $('aiStatus');
        els.aiOk = $('aiOk');
        els.aiCancel = $('aiCancel');
        els.aiMenu = $('aiMenu');
        els.aiChatPanel = $('aiChatPanel');
        els.aiChatMsgs = $('aiChatMsgs');
        els.aiChatInput = $('aiChatInput');
        els.aiChatSend = $('aiChatSend');
        els.aiChatClose = $('aiChatClose');
        els.aiCfgModal = $('aiCfgModal');
        els.cfgKey = $('cfgKey');
        els.cfgKeyHint = $('cfgKeyHint');
        els.cfgModel = $('cfgModel');
        els.cfgImageModel = $('cfgImageModel');
        els.cfgSearchModel = $('cfgSearchModel');
        els.cfgEndpoint = $('cfgEndpoint');
        els.cfgStatus = $('cfgStatus');
        els.cfgOk = $('cfgOk');
        els.cfgCancel = $('cfgCancel');
        els.aiErrRow = $('aiErrRow');
        els.aiErrBtnRow = $('aiErrBtnRow');
        els.aiErrBox = $('aiErrBox');
        els.aiErrCopy = $('aiErrCopy');
        els.errModal = $('errModal');
        els.errTitle = $('errTitle');
        els.errText = $('errText');
        els.errClose = $('errClose');
        els.errCopy = $('errCopy');

        /* 拖放提示層（獨立 g，避免 render 清掉） */
        els.dropHint = mk('g', { 'class': 'mm-drop-hint' });
        els.viewport.appendChild(els.dropHint);
    }

    function bindEvents() {
        els.svg.addEventListener('pointerdown', onPointerDown);
        els.svg.addEventListener('pointermove', onPointerMove);
        els.svg.addEventListener('pointerup', onPointerUp);
        els.svg.addEventListener('pointercancel', onPointerUp);
        els.svg.addEventListener('dblclick', onDblClick);
        els.svg.addEventListener('contextmenu', onContextMenu);
        els.stage.addEventListener('wheel', onWheel, { passive: false });
        /* 防止 Ctrl/Cmd+滾輪（或觸控板缩放手勢）觸發瀏覽器原生整頁縮放，
           確保只有畫布本身的縮放（onWheel）會生效，避免工具列/側邊欄跟著跑版 */
        document.addEventListener('wheel', function (e) {
            if (e.ctrlKey || e.metaKey) e.preventDefault();
        }, { passive: false });
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('paste', handlePaste);
        document.addEventListener('pointerdown', function (e) {
            if (!els.ctxMenu.classList.contains('hidden') && !els.ctxMenu.contains(e.target)) hideCtxMenu();
        }, true);

        els.editor.addEventListener('blur', function () { commitEdit(true); });
        els.editor.addEventListener('input', function () {
            els.editor.style.height = 'auto';
            els.editor.style.height = els.editor.scrollHeight + 'px';
        });

        els.mapTitle.addEventListener('change', commitTitle);
        els.mapTitle.addEventListener('blur', commitTitle);

        $('btnSave').addEventListener('click', function () { commitTitle(); saveMap(); });
        $('btnUndo').addEventListener('click', undo);
        $('btnRedo').addEventListener('click', redo);
        $('btnAddChild').addEventListener('click', function () {
            if (!state.selectedId) return;
            var id = addChild(state.selectedId);
            if (id) startEdit(id, null, true);
        });
        $('btnAddSibling').addEventListener('click', function () {
            if (!state.selectedId) return;
            var id = addSibling(state.selectedId);
            if (id) startEdit(id, null, true);
        });
        $('btnDelete').addEventListener('click', function () { if (state.selectedId) removeNode(state.selectedId); });
        $('btnZoomIn').addEventListener('click', function () { zoomStep(1.15); });
        $('btnZoomOut').addEventListener('click', function () { zoomStep(1 / 1.15); });
        $('zoomLabel').addEventListener('click', function () {
            state.scale = 1;
            fitViewKeepScale();
        });
        $('btnFit').addEventListener('click', fitView);
        $('btnTidy').addEventListener('click', tidyFloating);
        if (els.btnPitch) els.btnPitch.addEventListener('click', enterPitch);
        if (els.pitchPrev) els.pitchPrev.addEventListener('click', pitchPrev);
        if (els.pitchNext) els.pitchNext.addEventListener('click', pitchNext);
        if (els.pitchClose) els.pitchClose.addEventListener('click', exitPitch);
        if (els.btnAiGen) els.btnAiGen.addEventListener('click', function (e) { e.stopPropagation(); toggleAiMenu(); });
        window.addEventListener('resize', function () { toggleAiMenu(false); });
        /* 工具列氣泡提示（data-tip） */
        els.tbTip = $('tbTip');
        if (els.tbTip) {
            document.addEventListener('mouseover', function (e) {
                var t = e.target.closest ? e.target.closest('[data-tip]') : null;
                if (!t) { els.tbTip.classList.remove('show'); return; }
                var r = t.getBoundingClientRect();
                els.tbTip.textContent = t.getAttribute('data-tip');
                els.tbTip.style.top = (r.bottom + 8) + 'px';
                els.tbTip.style.left = Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60) + 'px';
                els.tbTip.classList.add('show');
            });
            document.addEventListener('mousedown', function () { els.tbTip.classList.remove('show'); });
        }
        if (els.aiMenu) {
            els.aiMenu.addEventListener('click', onAiMenuClick);
            document.addEventListener('click', function (e) {
                if (!els.aiMenu.classList.contains('hidden') && !els.aiMenu.contains(e.target)) toggleAiMenu(false);
            });
        }
        if (els.aiChatSend) els.aiChatSend.addEventListener('click', aiChatSubmit);
        if (els.cfgOk) els.cfgOk.addEventListener('click', saveAiCfg);
        if (els.cfgCancel) els.cfgCancel.addEventListener('click', function () { els.aiCfgModal.classList.add('hidden'); });
        if (els.errClose) els.errClose.addEventListener('click', closeErrModal);
        if (els.errCopy) els.errCopy.addEventListener('click', copyErrText);
        if (els.aiChatClose) els.aiChatClose.addEventListener('click', function () { toggleAiChat(false); });
        if (els.aiChatInput) els.aiChatInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiChatSubmit(); }
            e.stopPropagation();   /* 避免觸發畫布快捷鍵 */
        });
        if (els.aiOk) els.aiOk.addEventListener('click', commitAiModal);
        if (els.aiErrCopy) els.aiErrCopy.addEventListener('click', function () {
            if (!els.aiErrBox) return;
            els.aiErrBox.focus(); els.aiErrBox.select();
            var ok = false;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(els.aiErrBox.value).then(function () { toast('已複製訊息'); }).catch(function () { toast('已全選，請按 Ctrl+C', true); });
                ok = true;
            }
            if (!ok) toast('已全選，請按 Ctrl+C', true);
        });
        if (els.aiCancel) els.aiCancel.addEventListener('click', closeAiModal);
        bindStylePanel();
        $('btnExport').addEventListener('click', exportPNG);
        if (els.btnExportSvg) els.btnExportSvg.addEventListener('click', exportSVG);
        $('btnDrawer').addEventListener('click', function () {
            setDrawerOpen(els.drawer.classList.contains('closed'));
        });
        try {
            if (localStorage.getItem('mm.drawerOpen') === '0') els.drawer.classList.add('closed');
        } catch (e) { }
        $('btnNewMap').addEventListener('click', createNewMap);
        if ($('btnNewFolder')) $('btnNewFolder').addEventListener('click', createFolderPrompt);
        if (els.btnAddSheet) els.btnAddSheet.addEventListener('click', function () { addSheet(); });
        $('btnHelp').addEventListener('click', function () { $('helpModal').classList.remove('hidden'); });
        $('btnHelpClose').addEventListener('click', function () { $('helpModal').classList.add('hidden'); });
        $('helpModal').addEventListener('click', function (e) {
            if (e.target === $('helpModal')) $('helpModal').classList.add('hidden');
        });

        var chk = $('chkAutoSave');
        try {
            var saved = localStorage.getItem('mm.autoSave');
            if (saved !== null) state.autoSave = (saved === '1');
        } catch (e) { }
        chk.checked = state.autoSave;
        chk.addEventListener('change', function () {
            state.autoSave = chk.checked;
            try { localStorage.setItem('mm.autoSave', chk.checked ? '1' : '0'); } catch (e) { }
        });

        setInterval(function () {
            if (state.autoSave && state.dirty && !state.saving && !state.editingId && !state.pitch) saveMap(true);
        }, AUTOSAVE_MS);

        window.addEventListener('beforeunload', function (e) {
            if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
        });
        window.addEventListener('resize', function () { setViewport(); });
    }

    /* 100% 縮放但將內容置中 */
    function fitViewKeepScale() {
        var vw = els.stage.clientWidth, vh = els.stage.clientHeight;
        var bb = contentBBox();
        state.panX = vw / 2 - state.scale * (bb.x + bb.w / 2);
        state.panY = vh / 2 - state.scale * (bb.y + bb.h / 2);
        setViewport();
    }

    function boot() {
        return refreshMapList().then(function (r) {
            /* refreshMapList 回傳 { maps, folders }；相容直接回陣列的情況 */
            var maps = Array.isArray(r) ? r : ((r && r.maps) ? r.maps : []);
            if (!maps.length) {
                return api('createmap', { body: { title: '未命名心智圖' } }).then(function (res) {
                    if (res && res.ok) return openMap(res.mapId);
                    toast((res && res.error) || '初始化失敗', true);
                });
            }
            var last = null;
            try { last = localStorage.getItem('mm.lastMapId'); } catch (e) { }
            var pick = maps[0].mapId;
            for (var i = 0; i < maps.length; i++) if (String(maps[i].mapId) === String(last)) { pick = maps[i].mapId; break; }
            return openMap(pick);
        });
    }

    var readyResolve;
    window.__MM_READY__ = new Promise(function (res) { readyResolve = res; });

    /* ---- 後端 API 設定（GitHub Pages 靜態版）---- */
    function mmSettingsModal(firstRun) {
        return new Promise(function (resolve) {
            var back = document.createElement('div');
            back.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(20,26,34,.5);display:flex;align-items:center;justify-content:center;';
            var box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:22px 24px;width:min(520px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:inherit;color:#2B3440;';
            box.innerHTML =
                '<h3 style="margin:0 0 10px;font-size:17px;">後端連線設定</h3>' +
                '<p style="margin:0 0 8px;font-size:13px;color:#6B7684;line-height:1.7;">貼上 Google Apps Script 部署網址（結尾 /exec）。資料存在你自己的 Google 帳號，跨裝置同步。</p>' +
                '<input id="mmApiInput" type="url" placeholder="https://script.google.com/macros/s/.../exec" ' +
                'style="width:100%;padding:9px 12px;border:1px solid #E3E6EA;border-radius:8px;font-size:14px;box-sizing:border-box;" />' +
                '<div id="mmApiMsg" style="font-size:12px;color:#D9534F;min-height:18px;margin-top:6px;line-height:1.6;"></div>' +
                '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
                (firstRun ? '' : '<button id="mmApiCancel" style="padding:7px 16px;border:1px solid #E3E6EA;border-radius:8px;background:#fff;cursor:pointer;font:inherit;">取消</button>') +
                '<button id="mmApiOk" style="padding:7px 16px;border:0;border-radius:8px;background:#3D8AF7;color:#fff;font-weight:600;cursor:pointer;font:inherit;">測試並儲存</button></div>';
            back.appendChild(box); document.body.appendChild(back);
            var input = box.querySelector('#mmApiInput');
            input.value = apiBase(); input.focus();
            var msg = box.querySelector('#mmApiMsg');
            var cancel = box.querySelector('#mmApiCancel');
            if (cancel) cancel.onclick = function () { back.remove(); resolve(false); };
            var ok = box.querySelector('#mmApiOk');
            ok.onclick = function () {
                var v = input.value.trim();
                if (!v) { input.focus(); return; }
                ok.disabled = true; ok.textContent = '測試中...'; msg.style.color = '#6B7684'; msg.textContent = '連線測試中...';
                var prev = apiBase();
                try { localStorage.setItem('mm.apiUrl', v); } catch (e) { }
                api('listmaps').then(function (res) {
                    if (!res || !res.ok) throw new Error((res && res.error) || '回應異常');
                    back.remove(); resolve(true);
                }).catch(function (e) {
                    try { localStorage.setItem('mm.apiUrl', prev); } catch (ee) { }
                    ok.disabled = false; ok.textContent = '測試並儲存';
                    msg.style.color = '#D9534F';
                    msg.textContent = '連線失敗：' + e.message;
                });
            };
            input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.onclick(); });
        });
    }

    function injectSettingsButton() {
        if (document.getElementById('mmApiGear')) return;
        var b = document.createElement('button');
        b.id = 'mmApiGear'; b.title = '後端連線設定'; b.type = 'button'; b.textContent = '\u2699';
        b.style.cssText = 'position:fixed;right:12px;bottom:64px;z-index:500;width:38px;height:38px;border-radius:50%;border:1px solid #E3E6EA;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.15);cursor:pointer;font-size:17px;color:#6B7684;';
        b.onclick = function () { mmSettingsModal(false).then(function (ok) { if (ok) location.reload(); }); };
        document.body.appendChild(b);
    }

    function init() {
        cacheEls();
        measureInit();
        bindEvents();
        setViewport();
        injectSettingsButton();
        var gate = apiBase() ? Promise.resolve(true) : mmSettingsModal(true);
        gate.then(function () { return boot(); })
            .then(function () { readyResolve(true); })
            .catch(function (e) {
                toast('無法連線到後端 API：' + e.message, true);
                readyResolve(false);
            });
    }

    /* 測試掛勾（jsdom 模擬測試使用） */
    window.__MM__ = {
        state: state,
        node: node,
        childrenOf: childrenOf,
        buildChildIndex: buildChildIndex,
        addChild: addChild,
        addSibling: addSibling,
        removeNode: removeNode,
        setText: setText,
        toggleCollapse: toggleCollapse,
        setColor: setColor,
        applyReparent: applyReparent,
        layoutAll: layoutAll,
        render: render,
        serializeNodes: serializeNodes,
        serializeDoc: serializeDoc,
        hydrateDoc: hydrateDoc,
        structureOf: structureOf,
        setStructure: setStructure,
        floatingRoots: floatingRoots,
        addSheet: addSheet,
        switchSheet: switchSheet,
        renameSheet: renameSheet,
        deleteSheet: deleteSheet,
        addFloating: addFloating,
        detachToFloating: detachToFloating,
        setFloatingPos: setFloatingPos,
        tidyFloating: tidyFloating,
        pinNodeAt: pinNodeAt,
        clearNodePos: clearNodePos,
        clearAllPins: clearAllPins,
        saveMapAsById: saveMapAsById,
        moveMapToFolder: moveMapToFolder,
        createFolderNamed: createFolderNamed,
        deleteFolderById: deleteFolderById,
        refreshMapList: refreshMapList,
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        setDrawerOpen: setDrawerOpen,
        nodeAtPoint: nodeAtPoint,
        addCallout: addCallout,
        setCalloutOffset: setCalloutOffset,
        addRelation: addRelation,
        removeRelation: removeRelation,
        setRelationLabel: setRelationLabel,
        setRelationBend: setRelationBend,
        clearRelationBend: clearRelationBend,
        selectRelation: selectRelation,
        startLinking: startLinking,
        select: select,
        setPrimary: setPrimary,
        toggleSelect: toggleSelect,
        rangeSelect: rangeSelect,
        removeNodes: removeNodes,
        addBoundary: addBoundary,
        boundaryClusters: boundaryClusters,
        normalizeMembers: normalizeMembers,
        removeBoundary: removeBoundary,
        setBoundaryLabel: setBoundaryLabel,
        setBoundaryColor: setBoundaryColor,
        selectBoundary: selectBoundary,
        addSummary: addSummary,
        setProps: setProps,
        setTheme: setTheme,
        followLink: followLink,
        insertImage: insertImage,
        removeImage: removeImage,
        addAttachment: addAttachment,
        removeAttachment: removeAttachment,
        fileUrl: fileUrl,
        slides: slides,
        enterPitch: enterPitch,
        exitPitch: exitPitch,
        goSlide: goSlide,
        pitchNext: pitchNext,
        pitchPrev: pitchPrev,
        parseAiJson: parseAiJson,
        aiExpand: aiExpand,
        aiGenerateMap: aiGenerateMap,
        buildExportSvg: buildExportSvg,
        exportSVG: exportSVG,
        exportPNG: exportPNG,
        undo: undo,
        redo: redo,
        saveMap: saveMap,
        openMap: openMap,
        fitView: fitView,
        wrapText: wrapText,
        countDesc: countDesc,
        isDescendant: isDescendant
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
