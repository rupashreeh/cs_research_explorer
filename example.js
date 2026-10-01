(function(){
  "use strict";
  var L = window.L;
  var esc = L.esc, key = L.key, state = L.state, el = L.el;
  var askJSON = L.askJSON, backend = L.backend, routeName = L.routeName;
  var VOICE = L.VOICE, DRAFT_ROUTE = L.DRAFT_ROUTE, AUDIT_ROUTE = L.AUDIT_ROUTE;
  var setStatus = L.setStatus, setError = L.setError, friendly = L.friendly;
  var current = L.current;

  state.walks = {};

  // ---------- falsification ----------
  // Runs a generated program on randomised concrete states and tests each
  // step's claim against the state the program actually reaches. This refutes;
  // it does not certify. Nothing here evaluates model text as code: expressions
  // go through the parser below, over a fixed grammar, and anything outside it
  // is rejected.

  var TRIALS = 200;

  // --- tokenizer ---
  function lex(src){
    var out = [], i = 0, s = String(src || '');
    var ops = ['&&','||','==','!=','<=','>=','<','>','+','-','*','/','%','(',')','[',']','!'];
    while (i < s.length){
      var c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r'){ i++; continue; }
      if (c >= '0' && c <= '9'){
        var j = i; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        out.push({k:'num', v:parseInt(s.slice(i,j),10)}); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)){
        var j2 = i; while (j2 < s.length && /[A-Za-z0-9_']/.test(s[j2])) j2++;
        out.push({k:'id', v:s.slice(i,j2)}); i = j2; continue;
      }
      var hit = null;
      for (var o = 0; o < ops.length; o++){
        if (s.startsWith(ops[o], i)){ hit = ops[o]; break; }
      }
      if (!hit) throw new Error('unexpected character ' + JSON.stringify(c));
      out.push({k:'op', v:hit}); i += hit.length;
    }
    out.push({k:'end'});
    return out;
  }

  // --- recursive-descent parser over a closed grammar ---
  function parseExpr(src){
    var ts = lex(src), p = 0;
    function peek(){ return ts[p]; }
    function eat(v){
      var t = ts[p];
      if (t.k === 'op' && t.v === v){ p++; return true; }
      return false;
    }
    function expect(v){ if (!eat(v)) throw new Error('expected ' + v); }

    function primary(){
      var t = peek();
      if (t.k === 'num'){ p++; return {n:'num', v:t.v}; }
      if (t.k === 'op' && t.v === '('){ p++; var e = or(); expect(')'); return e; }
      if (t.k === 'op' && t.v === '-'){ p++; return {n:'neg', a:primary()}; }
      if (t.k === 'op' && t.v === '!'){ p++; return {n:'not', a:primary()}; }
      if (t.k === 'id'){
        p++;
        if (t.v === 'h' && peek().k === 'op' && peek().v === '['){
          p++; var idx = or(); expect(']'); return {n:'deref', a:idx};
        }
        return {n:'var', v:t.v};
      }
      throw new Error('unexpected token');
    }
    function mul(){
      var l = primary();
      for (;;){
        if (eat('*'))      l = {n:'bin', o:'*', a:l, b:primary()};
        else if (eat('/')) l = {n:'bin', o:'/', a:l, b:primary()};
        else if (eat('%')) l = {n:'bin', o:'%', a:l, b:primary()};
        else return l;
      }
    }
    function add(){
      var l = mul();
      for (;;){
        if (eat('+'))      l = {n:'bin', o:'+', a:l, b:mul()};
        else if (eat('-')) l = {n:'bin', o:'-', a:l, b:mul()};
        else return l;
      }
    }
    function cmp(){
      var l = add();
      var o = ['==','!=','<=','>=','<','>'];
      for (var i = 0; i < o.length; i++){
        if (eat(o[i])) return {n:'cmp', o:o[i], a:l, b:add()};
      }
      return l;
    }
    function and(){
      var l = cmp();
      while (eat('&&')) l = {n:'and', a:l, b:cmp()};
      return l;
    }
    function or(){
      var l = and();
      while (eat('||')) l = {n:'or', a:l, b:and()};
      return l;
    }

    var ast = or();
    if (peek().k !== 'end') throw new Error('trailing input');
    return ast;
  }

  function evalAst(ast, st){
    switch (ast.n){
      case 'num':   return ast.v;
      case 'neg':   return -num(evalAst(ast.a, st));
      case 'not':   return !bool(evalAst(ast.a, st));
      case 'var':
        if (Object.prototype.hasOwnProperty.call(st.locs, ast.v)) return st.locs[ast.v];
        if (Object.prototype.hasOwnProperty.call(st.vars, ast.v)) return st.vars[ast.v];
        throw new Error('unbound ' + ast.v);
      case 'deref': {
        var L = num(evalAst(ast.a, st));
        if (!Object.prototype.hasOwnProperty.call(st.heap, L)) throw new Error('dangling deref');
        return st.heap[L];
      }
      case 'bin': {
        var x = num(evalAst(ast.a, st)), y = num(evalAst(ast.b, st));
        if (ast.o === '+') return x + y;
        if (ast.o === '-') return x - y;
        if (ast.o === '*') return x * y;
        if (y === 0) throw new Error('division by zero');
        return ast.o === '/' ? Math.trunc(x / y) : x % y;
      }
      case 'cmp': {
        var a = evalAst(ast.a, st), b = evalAst(ast.b, st);
        switch (ast.o){
          case '==': return a === b;
          case '!=': return a !== b;
          case '<':  return num(a) <  num(b);
          case '<=': return num(a) <= num(b);
          case '>':  return num(a) >  num(b);
          case '>=': return num(a) >= num(b);
        }
        return false;
      }
      case 'and': return bool(evalAst(ast.a, st)) && bool(evalAst(ast.b, st));
      case 'or':  return bool(evalAst(ast.a, st)) || bool(evalAst(ast.b, st));
    }
    throw new Error('bad node');
  }
  function num(v){ if (typeof v !== 'number' || !isFinite(v)) throw new Error('not a number'); return v; }
  function bool(v){ if (typeof v !== 'boolean') throw new Error('not a boolean'); return v; }

  // --- trials ---
  function sampleInts(names, rnd){
    var v = {};
    names.forEach(function(n){ v[n] = rnd(); });
    return v;
  }

  function aliasLayouts(addrs){
    // every distinct, then each pair collapsed — aliasing is where the bugs are
    var outs = [], base = {};
    addrs.forEach(function(a, i){ base[a] = i; });
    outs.push(base);
    for (var i = 0; i < addrs.length; i++){
      for (var j = i+1; j < addrs.length; j++){
        var m = {};
        addrs.forEach(function(a, k){ m[a] = k; });
        m[addrs[j]] = m[addrs[i]];
        outs.push(m);
      }
    }
    return outs;
  }

  function runProgram(model, st){
    (model.program || []).forEach(function(op, idx){
      if (op.op === 'read'){
        var L = st.locs[op.addr];
        if (L === undefined || !Object.prototype.hasOwnProperty.call(st.heap, L))
          throw new Error('read of unallocated address');
        st.vars[op.dst] = st.heap[L];
      } else if (op.op === 'write'){
        var L2 = st.locs[op.addr];
        if (L2 === undefined) throw new Error('write to unknown address');
        st.heap[L2] = num(evalAst(op._ast, st));
      } else if (op.op === 'assign'){
        st.vars[op.dst] = num(evalAst(op._ast, st));
      } else {
        throw new Error('unknown op ' + op.op);
      }
      st.after = idx;
    });
  }

  // Returns per-step verdicts keyed by step index.
  function falsify(model, claims){
    var res = {};
    claims.forEach(function(c){ res[c.step] = {status:'unchecked'}; });
    if (!model || !model.program || !model.program.length) return res;

    // pre-compile everything; a parse failure marks only what depends on it
    try {
      (model.program || []).forEach(function(op){
        if (op.expr != null) op._ast = parseExpr(op.expr);
      });
    } catch (e) {
      claims.forEach(function(c){ res[c.step] = {status:'unchecked', why:'program did not parse'}; });
      return res;
    }

    var initPairs = [];
    try {
      Object.keys(model.init || {}).forEach(function(a){
        initPairs.push([a, parseExpr(model.init[a])]);
      });
    } catch (e) { return res; }

    var compiled = [];
    claims.forEach(function(c){
      try { compiled.push({step:c.step, at:c.at, ast:parseExpr(c.claim), text:c.claim}); }
      catch (e) { res[c.step] = {status:'unchecked', why:'claim did not parse'}; }
    });
    if (!compiled.length) return res;

    var pre = null;
    if (model.pre){ try { pre = parseExpr(model.pre); } catch (e) { pre = null; } }

    var ints = model.ints || [];
    var addrs = model.addrs || [];
    var layouts = aliasLayouts(addrs);
    var seedv = 1;
    function rnd(){
      // small deterministic LCG, biased toward awkward values
      seedv = (seedv * 1103515245 + 12345) & 0x7fffffff;
      var r = seedv % 100;
      if (r < 12) return 0;
      if (r < 20) return -(seedv % 50);
      return seedv % 500;
    }

    var surviving = {}, tested = 0, admitted = 0;
    compiled.forEach(function(c){ surviving[c.step] = 0; });

    for (var t = 0; t < TRIALS; t++){
      var locs = layouts[t % layouts.length];
      var vars = sampleInts(ints, rnd);
      var st = {vars:vars, heap:{}, locs:locs};

      var ok = true;
      try {
        initPairs.forEach(function(pr){ st.heap[locs[pr[0]]] = num(evalAst(pr[1], st)); });
        if (pre && evalAst(pre, st) !== true) ok = false;   // state not in the precondition
      } catch (e) { ok = false; }
      if (!ok) continue;
      admitted++;

      // snapshot the state after each program line
      var snaps = [JSON.parse(JSON.stringify({vars:st.vars, heap:st.heap, locs:st.locs}))];
      try {
        (model.program || []).forEach(function(op){
          runProgram({program:[op]}, st);
          snaps.push(JSON.parse(JSON.stringify({vars:st.vars, heap:st.heap, locs:st.locs})));
        });
      } catch (e) { continue; }

      tested++;
      for (var ci = 0; ci < compiled.length; ci++){
        var c = compiled[ci];
        var prior = res[c.step];
        if (prior && prior.status === 'refuted' && prior.score === 0) continue;
        var at = Math.max(0, Math.min(snaps.length - 1, c.at == null ? snaps.length - 1 : c.at));
        var v;
        try { v = evalAst(c.ast, snaps[at]); } catch (e) { continue; }
        if (v === false){
          // prefer a counterexample that is not all zeros — it reads better
          var zeros = ints.filter(function(nm){ return snaps[0].vars[nm] === 0; }).length;
          if (!prior || prior.status !== 'refuted' || zeros < prior.score){
            res[c.step] = {
              status: 'refuted',
              at: at,
              claim: c.text,
              score: zeros,
              witness: describeState(snaps[0], addrs, ints)
            };
          }
        } else if (v === true){
          surviving[c.step]++;
        }
      }
    }

    compiled.forEach(function(c){
      if (res[c.step] && res[c.step].status === 'refuted') return;
      if (surviving[c.step] > 0) res[c.step] = {status:'survived', n:surviving[c.step]};
      else res[c.step] = {status:'unchecked', why: admitted ? 'claim never evaluated' : 'no state satisfied the precondition'};
    });

    return res;
  }

  function describeState(snap, addrs, ints){
    var parts = [];
    var seen = {};
    addrs.forEach(function(a){
      var L = snap.locs[a];
      if (seen[L] !== undefined) parts.push(a + ' = ' + seen[L] + ' (same cell)');
      else { seen[L] = a; parts.push(a + ' ↦ ' + snap.heap[L]); }
    });
    ints.forEach(function(n){ if (snap.vars[n] !== undefined) parts.push(n + ' = ' + snap.vars[n]); });
    return parts.join(', ');
  }

  function badge(v){
    if (!v) return '';
    if (v.status === 'refuted'){
      return '<div class="chk bad-chk"><span class="chk-tag">Refuted</span>' +
        '<span class="chk-note">Fails when ' + esc(v.witness) + '. ' +
        'The claim <code>' + esc(v.claim) + '</code> is false in the state the program actually reaches.</span></div>';
    }
    if (v.status === 'survived'){
      return '<div class="chk ok-chk"><span class="chk-tag">Survived ' + v.n + ' states</span>' +
        '<span class="chk-note">Held on every generated state, including the aliasing cases. Not a proof.</span></div>';
    }
    return '<div class="chk nil-chk"><span class="chk-tag">Not checkable</span>' +
      '<span class="chk-note">' + esc(v.why || 'No executable claim was supplied for this step.') + '</span></div>';
  }

  // ---------- diagrams ----------
  // Declared as primitives, painted through rough.js for a hand-drawn look.
  // If the CDN script does not load, the same primitives paint as plain SVG.
  var SEEDN = 42;

  function themeColors(){
    var cs = getComputedStyle(document.body);
    function v(n, f){ var x = cs.getPropertyValue(n).trim(); return x || f; }
    return {
      fg:     v('--fg', '#111'),
      accent: v('--accent', '#23408e'),
      warn:   v('--warn', '#8a5d1b'),
      bad:    v('--bad', '#9b2f2f'),
      muted:  v('--muted', '#666')
    };
  }

  // --- templates: each returns {w, h, p:[primitives]} ---
  function tplCells(L){
    var p = [], x = 18;
    for (var i = 0; i < Math.min(2, L.length); i++){
      p.push({t:'text', x:x, y:62, s:L[i] ? String(L[i]).split('|')[0] : '', size:13, c:'fg', italic:true});
      p.push({t:'line', x1:x+16, y1:57, x2:x+62, y2:57, arrow:true, c:'fg'});
      p.push({t:'rect', x:x+68, y:38, w:92, h:40, c:'accent'});
      p.push({t:'text', x:x+114, y:63, s:(L[i]||'').split('|')[1] || '', size:13, c:'accent', anchor:'middle'});
      x += 212;
    }
    return {w:450, h:104, p:p};
  }

  function tplSplit(L){
    return {w:450, h:124, p:[
      {t:'rect', x:16, y:24, w:418, h:74, c:'muted', dash:true},
      {t:'rect', x:36, y:40, w:160, h:44, c:'accent'},
      {t:'text', x:116, y:68, s:L[0]||'', size:13, c:'accent', anchor:'middle'},
      {t:'text', x:225, y:70, s:'∗', size:19, c:'fg', anchor:'middle'},
      {t:'rect', x:254, y:40, w:160, h:44, c:'accent'},
      {t:'text', x:334, y:68, s:L[1]||'', size:13, c:'accent', anchor:'middle'},
      {t:'text', x:225, y:114, s:L[2]||'', size:11, c:'muted', anchor:'middle'}
    ]};
  }

  function tplFlow(L){
    var p = [], n = Math.min(3, L.length), x = 18, bw = 124;
    for (var i = 0; i < n; i++){
      p.push({t:'rect', x:x, y:30, w:bw, h:48, c: i===1 ? 'accent' : 'fg'});
      p.push({t:'text', x:x+bw/2, y:59, s:L[i]||'', size:12, c: i===1 ? 'accent' : 'fg', anchor:'middle'});
      if (i < n-1) p.push({t:'line', x1:x+bw+4, y1:54, x2:x+bw+32, y2:54, arrow:true, c:'fg'});
      x += bw + 36;
    }
    return {w:460, h:94, p:p};
  }

  function tplTimeline(L){
    var p = [{t:'line', x1:28, y1:62, x2:432, y2:62, c:'muted'}];
    var n = Math.min(4, L.length), gap = n > 1 ? 360/(n-1) : 0;
    for (var i = 0; i < n; i++){
      var cx = 48 + gap*i, bad = (n > 2 && i === 1);
      p.push({t:'dot', x:cx, y:62, r: bad?7:5, c: bad?'bad':'fg'});
      p.push({t:'text', x:cx, y:40, s:L[i]||'', size:11, c: bad?'bad':'fg', anchor:'middle'});
    }
    return {w:460, h:92, p:p};
  }

  function tplNodes(L){
    return {w:450, h:130, p:[
      {t:'rect', x:20, y:34, w:146, h:56, c:'fg'},
      {t:'text', x:93, y:60, s:L[0]||'', size:13, c:'fg', anchor:'middle'},
      {t:'text', x:93, y:79, s:L[1]||'', size:11, c:'muted', anchor:'middle'},
      {t:'line', x1:172, y1:58, x2:280, y2:58, arrow:true, dash:true, c:'fg'},
      {t:'text', x:226, y:48, s:L[2]||'', size:11, c:'muted', anchor:'middle'},
      {t:'rect', x:286, y:34, w:146, h:56, c:'warn'},
      {t:'text', x:359, y:60, s:L[3]||'', size:13, c:'warn', anchor:'middle'},
      {t:'text', x:359, y:79, s:L[4]||'', size:11, c:'warn', anchor:'middle'},
      {t:'text', x:226, y:118, s:L[5]||'', size:11, c:'muted', anchor:'middle'}
    ]};
  }

  var TPL = { cells:tplCells, split:tplSplit, flow:tplFlow, timeline:tplTimeline, nodes:tplNodes };

  function svgEl(n, a){
    var e = document.createElementNS('http://www.w3.org/2000/svg', n);
    for (var k in a) if (a[k] != null) e.setAttribute(k, a[k]);
    return e;
  }

  function paintOne(slot){
    var spec;
    try { spec = JSON.parse(slot.getAttribute('data-fig')); } catch (e) { return; }
    var build = TPL[spec.kind]; if (!build) return;
    var d = build(spec.labels || []);
    var C = themeColors();

    slot.textContent = '';
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + d.w + ' ' + d.h,
      role: 'img',
      'aria-label': spec.caption || 'diagram'
    });

    var rc = null;
    try { if (window.rough && window.rough.svg) rc = window.rough.svg(svg); } catch (e) { rc = null; }
    var seed = SEEDN;

    d.p.forEach(function(s){
      var col = C[s.c] || C.fg;
      if (s.t === 'text'){
        var tx = svgEl('text', {x:s.x, y:s.y, 'font-size':s.size||12, fill:col,
          'text-anchor':s.anchor||'start', 'font-style': s.italic ? 'italic' : null});
        tx.textContent = s.s || '';
        svg.appendChild(tx);
        return;
      }
      if (s.t === 'dot'){
        if (rc) svg.appendChild(rc.circle(s.x, s.y, (s.r||5)*2, {stroke:col, fill:col, fillStyle:'solid', roughness:1.1, seed:seed++}));
        else svg.appendChild(svgEl('circle', {cx:s.x, cy:s.y, r:s.r||5, fill:col}));
        return;
      }
      if (s.t === 'rect'){
        if (rc) svg.appendChild(rc.rectangle(s.x, s.y, s.w, s.h,
          {stroke:col, roughness:1.5, bowing:1.4, strokeWidth: s.dash?1:1.6,
           strokeLineDash: s.dash ? [6,5] : undefined, seed:seed++}));
        else svg.appendChild(svgEl('rect', {x:s.x, y:s.y, width:s.w, height:s.h, fill:'none',
          stroke:col, 'stroke-width': s.dash?1:1.6, 'stroke-dasharray': s.dash?'6 5':null, rx:3}));
        return;
      }
      if (s.t === 'line'){
        if (rc) svg.appendChild(rc.line(s.x1, s.y1, s.x2, s.y2,
          {stroke:col, roughness:1.4, strokeWidth:1.5,
           strokeLineDash: s.dash ? [6,5] : undefined, seed:seed++}));
        else svg.appendChild(svgEl('line', {x1:s.x1, y1:s.y1, x2:s.x2, y2:s.y2, stroke:col,
          'stroke-width':1.5, 'stroke-dasharray': s.dash?'6 5':null}));
        if (s.arrow){
          var dx = s.x2-s.x1, dy = s.y2-s.y1, L = Math.hypot(dx,dy) || 1;
          var ux = dx/L, uy = dy/L, hx = s.x2, hy = s.y2, sz = 7;
          var pts = [hx+','+hy,
                     (hx-ux*sz-uy*sz*0.5)+','+(hy-uy*sz+ux*sz*0.5),
                     (hx-ux*sz+uy*sz*0.5)+','+(hy-uy*sz-ux*sz*0.5)].join(' ');
          svg.appendChild(svgEl('polygon', {points:pts, fill:col}));
        }
        return;
      }
    });

    slot.appendChild(svg);
  }

  function paintFigs(root){
    (root || document).querySelectorAll('.figslot').forEach(paintOne);
  }

  // repaint on theme flip so rough's baked-in colours stay correct
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function(){ paintFigs(document); });
  } catch (e) {}

  // ---------- generated walkthrough ----------
  var DIAGRAM_SPEC =
    'For "diagram", choose ONE kind and supply labels:\n' +
    '- "cells": two memory cells. labels: ["name|value","name|value"]\n' +
    '- "split": one region divided in two. labels: ["left","right","note under it"]\n' +
    '- "flow": up to 3 stages left to right. labels: ["first","second","third"] (second is highlighted)\n' +
    '- "timeline": up to 4 points in time. labels: ["before","during","after","end"] (second is marked as the problem state)\n' +
    '- "nodes": two parties exchanging something. labels: ["A","A detail","message","B","B detail","note"]\n' +
    'Keep every label under 5 words. Omit "diagram" entirely when a picture would add nothing.\n';

  // The page runs this to try to REFUTE the generated claims on concrete states.
  var EXEC_SPEC =
    'Also emit "model": a runnable version of the example, so the page can test your claims.\n' +
    '  "addrs": heap address names, e.g. ["a","b"]. These may turn out to alias.\n' +
    '  "ints":  integer variable names, e.g. ["x","y","n"].\n' +
    '  "init":  initial contents of each address, e.g. {"a":"x","b":"y"}.\n' +
    '  "pre":   the precondition, e.g. "h[a] == x && h[b] == y". States failing it are skipped.\n' +
    '  "program": ordered ops, each one of:\n' +
    '     {"op":"read","dst":"ba","addr":"a"}  |  {"op":"write","addr":"a","expr":"ba - n"}  |\n' +
    '     {"op":"assign","dst":"t","expr":"x + 1"}\n' +
    'Then give each step a "check": {"claim": <expression>, "at": <number of program ops executed>}.\n' +
    '  "at":0 is before any op; "at":2 is after the second op.\n' +
    'Expressions may use: integers, the names above, h[addr] for an address\'s contents, a bare\n' +
    'address name for its identity (so "a != b" tests aliasing), + - * / %, == != < <= > >=, && || !.\n' +
    'Nothing else parses. Make each claim the assertion that step actually asserts, so that if your\n' +
    'reasoning is wrong the page finds a counterexample. Omit "check" only when a step asserts\n' +
    'nothing executable.\n';

  async function askWalk(node, trail, example, isSubfield){
    var ctx = trail.length > 1 ? ' It sits within ' + trail.slice(0, -1).join(' → ') + '.' : '';
    var exLine = example ? '\nUse this as the running example throughout:\n' +
      example.title + ' — ' + example.text + '\n' : '';

    var shape = isSubfield
      ? 'Work ONE concrete example end to end, in full detail, inside "' + node + '" specifically. ' +
        'Include the actual formal steps: if this area has a proof system, a calculus or an algorithm, ' +
        'show it applied line by line to the example, with the intermediate state after each step. ' +
        'Do not summarise the method. Perform it. 7 to 10 steps.'
      : 'Walk the example across the subfields of "' + node + '". Each step is one subfield, showing ' +
        'what it lets you state that the previous step could not, and why that forced a separate area ' +
        'to exist. 7 to 10 steps.';

    var prompt =
      'You are writing a worked example for a PhD student in programming languages and formal methods.' +
      ctx + exLine + '\n' + shape + '\n\n' +
      'Each step has:\n' +
      '- "title": the subfield or stage, under 5 words\n' +
      '- "question": what this step answers, as a question under 10 words\n' +
      '- "cant": what the PREVIOUS step could not express. Omit on step 1.\n' +
      '- "prose": 2-4 sentences. Concrete. Refer to the example by name.\n' +
      '- "formal": the actual notation, as plain text with real line breaks. Judgements, triples, ' +
      'assertions, rules. Use unicode symbols. Omit only if this step genuinely has no notation.\n' +
      '- "video": a real, well-known recorded talk or lecture on this topic, as {"title","speaker"}. ' +
      'Do NOT give a URL; the page builds a search link. Omit if you cannot name a real one.\n' +
      '- "diagram": optional, see below.\n\n' +
      DIAGRAM_SPEC + '\n' + EXEC_SPEC + '\n' + VOICE + '\n' +
      'Return JSON only, no prose:\n' +
      '{"intro":"2-3 sentences setting up what gets worked through",' +
      '"code":"optional short code block, plain text with newlines",' +
      '"model":{"addrs":[],"ints":[],"init":{},"pre":"","program":[]},' +
      '"steps":[{"title":"","question":"","cant":"","prose":"","formal":"",' +
      '"check":{"claim":"","at":0},' +
      '"video":{"title":"","speaker":""},"diagram":{"kind":"split","labels":[],"caption":""}}],' +
      '"close":"2-3 sentences on what is still unresolved"}';

    return await askJSON(prompt, DRAFT_ROUTE, 'complex', 4000);
  }

  function ytLink(v){
    if (!v || !v.title) return '';
    var q = encodeURIComponent(v.title + ' ' + (v.speaker || ''));
    return '<a class="yt" href="https://www.youtube.com/results?search_query=' + q + '" target="_blank" rel="noopener">' +
           '▶ ' + esc(v.title) + (v.speaker ? ' · ' + esc(v.speaker) : '') + '</a>';
  }

  function renderWalk(w){
    if (!w){ el.walk.innerHTML = ''; return; }
    var h = '';
    if (w.intro) h += '<p class="opening">' + esc(w.intro) + '</p>';
    if (w.code)  h += '<pre class="code">' + esc(w.code) + '</pre>';

    // try to refute each step's claim on concrete states
    var claims = [];
    (w.steps || []).forEach(function(s, i){
      if (s.check && s.check.claim) claims.push({step:i, claim:s.check.claim, at:s.check.at});
    });
    var verdicts = {};
    if (claims.length){
      try { verdicts = falsify(w.model, claims); } catch (e) { verdicts = {}; }
    }
    var refuted = Object.keys(verdicts).filter(function(k){ return verdicts[k].status === 'refuted'; }).length;
    if (claims.length){
      h += '<p class="runline">' + (refuted
        ? refuted + ' of ' + claims.length + ' claims were refuted by a concrete counterexample.'
        : 'All ' + claims.length + ' executable claims survived ' + TRIALS + ' generated states, aliasing cases included.') +
        '</p>';
    }

    (w.steps || []).forEach(function(s, i){
      h += '<section class="step">' +
        '<div class="step-n">' + (i+1) + '</div>' +
        '<div class="step-body">' +
          '<p class="step-sub">' + esc(s.title || '') + '</p>' +
          (s.question ? '<h4>' + esc(s.question) + '</h4>' : '') +
          (s.cant ? '<p class="cant"><b>Previously unsayable</b>' + esc(s.cant) + '</p>' : '') +
          (s.prose ? '<p>' + esc(s.prose) + '</p>' : '') +
          (s.diagram && s.diagram.kind
            ? '<figure class="fig"><div class="figslot" data-fig="' +
              esc(JSON.stringify(s.diagram)) + '"></div>' +
              (s.diagram.caption ? '<figcaption>' + esc(s.diagram.caption) + '</figcaption>' : '') +
              '</figure>'
            : '') +
          (s.formal ? '<pre class="formal">' + esc(s.formal) + '</pre>' : '') +
          badge(verdicts[i]) +
          (s.video && s.video.title ? '<p class="vid">' + ytLink(s.video) + '</p>' : '') +
        '</div></section>';
    });

    if (w.close) h += '<div class="closing"><b>Still open</b>' + esc(w.close) + '</div>';
    h += '<p class="checked">Each executable claim is run against concrete states the program ' +
         'actually reaches, so <em>refuted</em> is a real counterexample. <em>Survived</em> means ' +
         'no counterexample was found, which is weaker than a proof: a vacuous claim survives too, ' +
         'and prose without a claim is checked by nothing. Video links are searches, not verified URLs.</p>';

    el.walk.innerHTML = h;
    paintFigs(el.walk);
  }

  async function walkExample(){
    var label = current(); if (!label) return;
    var k = key(label), cached = state.walks[k];
    if (cached){ renderWalk(cached); return; }

    el.walkBtn.disabled = true;
    try {
      await backend();
      setStatus(routeName(DRAFT_ROUTE) + ' is working the example through ' + label + '…');
      var w = await askWalk(label, state.trail, state.examples[k], state.trail.length > 1);
      if (!w || !w.steps || !w.steps.length){
        setError('No walkthrough came back for ' + label + '. Try again, or a different subfield.');
        return;
      }
      state.walks[k] = w;
      renderWalk(w);
      setStatus('');
    } catch (e) {
      setError(friendly(e, 'work that example'));
    } finally {
      el.walkBtn.disabled = false;
    }
  }


  L.boot({
    showExample: true, showDemands: true,
    ids: ['walk','walkBtn'],
    onNode: function(label, k){
      el.walk.innerHTML = '';
      el.walkBtn.textContent = 'Walk the example in ' + label;
      el.actions.hidden = false;
    }
  });
  el.walkBtn.addEventListener('click', walkExample);
})();
