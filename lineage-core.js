(function(global){
  "use strict";

  var SEED = {
    "logic": {
      blurb: "The study of valid inference — and, in computer science, of what a machine may be trusted to conclude.",
      example: {
        title: "transfer(a, b, n)",
        text: "Move n from account a to account b. Other code runs at the same time, the accounts may sit on different machines, and the network may drop messages. Every branch of logic below exists because this one procedure demands something the others cannot say."
      },
      children: [
        {name:"Hoare Logic", demand:"State what the transfer guarantees, at all"},
        {name:"Separation Logic", demand:"Say a and b are different cells, without listing every inequality"},
        {name:"Linear Logic", demand:"Stop the proof from spending the same money twice"},
        {name:"Temporal Logic", demand:"Say ‘eventually settles’ and ‘never stuck in limbo’"},
        {name:"Modal Logic", demand:"Talk about what the other machine knows, not just what is true"},
        {name:"Intuitionistic Logic", demand:"Make ‘a solvent account exists’ hand you the account"},
        {name:"Higher-Order Logic", demand:"Quantify over the account invariants themselves"}
      ]
    },
    "type theory": {
      blurb: "Types as propositions, programs as proofs — and the long argument about how much a type should say.",
      example: {
        title: "firstLine(path)",
        text: "Open a file, read its first line, close it. The file may be empty, the caller may be holding other resources, and half the codebase around it is untyped. Each branch below widens what the type is allowed to promise."
      },
      children: [
        {name:"Simply Typed Lambda Calculus", demand:"Give the function a type at all, and have it terminate"},
        {name:"Polymorphism", demand:"Work for any line type without rewriting the function"},
        {name:"Dependent Types", demand:"Let the type itself say the file is non-empty"},
        {name:"Substructural Types", demand:"Close the handle exactly once — not zero times, not twice"},
        {name:"Session Types", demand:"Put open → read → close order into the type"},
        {name:"Gradual Typing", demand:"Interoperate with the untyped half without lying"}
      ]
    },
    "concurrency": {
      blurb: "What it means for a program to be correct when more than one thing is happening at once.",
      example: {
        title: "Two threads, one counter",
        text: "Both threads run count++ a thousand times. The answer should be two thousand and is not. Explaining exactly why, and what discipline would have prevented it, is what each of these areas was built to do."
      },
      children: [
        {name:"Memory Models", demand:"Say which reorderings the hardware and compiler may perform"},
        {name:"Linearizability", demand:"Define what ‘the counter is correct’ even means"},
        {name:"Concurrent Separation Logic", demand:"Prove non-interference by tracking who owns the cell"},
        {name:"Process Calculi", demand:"Treat the interaction itself as the thing being described"},
        {name:"Transactional Memory", demand:"Make the increment atomic without hand-placed locks"}
      ]
    },
    "distributed systems": {
      blurb: "Correctness when the parts fail independently and the network refuses to say which.",
      example: {
        title: "Two replicas, one partition",
        text: "The same account is replicated on two machines. The link between them drops, and a withdrawal arrives at each side. Every area below is a different answer to what the system should do next."
      },
      children: [
        {name:"Consensus", demand:"Force both sides to agree on one order before acting"},
        {name:"Consistency Models", demand:"Say precisely what a read is allowed to return"},
        {name:"CRDTs", demand:"Let both sides proceed and still converge afterwards"},
        {name:"Failure Detectors", demand:"Decide whether the other side is dead or just slow"},
        {name:"Byzantine Fault Tolerance", demand:"Survive a replica that reports a balance it knows is false"}
      ]
    },
    "verification": {
      blurb: "Proving a program meets its specification — and arguing about how much of that proof a machine should carry.",
      example: {
        title: "sort(xs) must not lose an element",
        text: "The output should be ordered and a permutation of the input. Checking that on every input is impossible by testing, so each area below is a different bargain between how much you prove and how much you automate."
      },
      children: [
        {name:"Model Checking", demand:"Search every reachable state, for a bounded version"},
        {name:"Abstract Interpretation", demand:"Approximate soundly when the state space will not fit"},
        {name:"SMT Solving", demand:"Discharge the arithmetic obligations automatically"},
        {name:"Proof Assistants", demand:"Carry the permutation argument for unbounded inputs"},
        {name:"Refinement", demand:"Derive the fast implementation from the obvious one"}
      ]
    },
    "automata theory": {
      blurb: "Machines defined by what they can remember, and the languages that fall out.",
      example: {
        title: "Is this bracket sequence balanced?",
        text: "A stream of opening and closing brackets arrives. Deciding whether it is well-formed turns out to be exactly a question about memory, and each machine below is defined by how much memory it is allowed."
      },
      children: [
        {name:"Finite Automata", demand:"Show that no fixed amount of memory suffices"},
        {name:"Pushdown Automata", demand:"Add a stack, and the problem becomes decidable"},
        {name:"Tree Automata", demand:"Recognise the nesting structure rather than the string"},
        {name:"ω-Automata", demand:"Handle a stream that never ends"},
        {name:"Timed Automata", demand:"Require each bracket to close within a deadline"}
      ]
    }
  };

  // ---------- backend ----------
  // Runs in two places. Inside claude.ai the page asks Claude directly.
  // On GitHub Pages it goes through the Cloudflare Worker.
  var PROXY = 'https://cs-research-proxy.rrangaiyengar.workers.dev';
  var DRAFT_ROUTE = '/gemini';   // '' = Claude, '/gemini', '/groq'
  var AUDIT_ROUTE = '/groq';     // must differ from DRAFT_ROUTE to be a real second opinion
  var S2 = 'https://api.semanticscholar.org/graph/v1/paper/search';

  var sample = null, mode = null;

  async function backend(){
    if (mode) return mode;
    try { sample = (window.claude && window.claude.use) ? await window.claude.use('sample') : null; }
    catch (e) { sample = null; }
    mode = sample ? 'claude' : 'worker';
    return mode;
  }

  function routeName(r){
    if (mode === 'claude') return 'Claude';
    return r === '/gemini' ? 'Gemini' : r === '/groq' ? 'Groq' : 'Claude';
  }

  function parseLoose(raw){
    if (!raw) return null;
    var t = String(raw).trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
    try { return JSON.parse(t); } catch (e) {}
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a > -1 && b > a) { try { return JSON.parse(t.slice(a, b+1)); } catch (e2) {} }
    return null;
  }

  async function askJSON(prompt, route, tier, maxTokens){
    var m = await backend();
    if (m === 'claude') return await sample.json(prompt, { modelTier: tier || 'default', cache: true });

    var r = await fetch(PROXY + route, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ max_tokens: maxTokens || 3000, messages:[{role:'user', content:prompt}] })
    });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { var e = new Error(j.error ? j.error.message : 'HTTP ' + r.status); e.http = r.status; throw e; }
    var raw = route === ''
      ? (j.content && j.content[0] ? j.content[0].text : '')
      : (j.choices && j.choices[0] ? j.choices[0].message.content : '');
    return parseLoose(raw);
  }

  // Shared with every generated prose prompt. The point is to strip the
  // register that gives machine writing away.
  var VOICE =
    'Voice rules, follow them strictly:\n' +
    '- Write the way a researcher explains something to a colleague who knows the area. Plain and direct.\n' +
    '- Vary sentence length. Some sentences should be short.\n' +
    '- Never use: revolutionised, paved the way, landmark, seminal, cornerstone, game-changing, ' +
    'at its core, it is worth noting, fundamentally, crucially, delve, leverage, robust, powerful.\n' +
    '- No asides set off by em-dashes. No "not just X, but Y". No colon-then-reveal sentences.\n' +
    '- No rhetorical questions. No sentence beginning "And yet" or "But here is the thing".\n' +
    '- Do not open consecutive sentences with the same word or construction.\n' +
    '- Prefer concrete nouns and active verbs. Name people and papers rather than "researchers".\n' +
    '- State what failed before. That is the interesting part, not the achievement.\n';

  async function askChildren(field){
    var prompt =
      'You are mapping how a field of computer science divides up, for a PhD student in programming ' +
      'languages and formal methods.\n\nField: "' + field + '"\n\n' +
      'First choose ONE concrete running example: a specific procedure, system or question from this ' +
      'field, small enough to state in two sentences. It must be an example that every subfield below ' +
      'has something to say about.\n\n' +
      'Then list 5 to 9 subfields. For each, give the "demand": the one thing the running example needs ' +
      'that this subfield exists to supply, and that the others cannot express. Under 11 words, written ' +
      'as a task, e.g. "Say a and b are different cells, without listing every inequality".\n\n' +
      'The reader should finish the list understanding why these had to become separate areas.\n\n' +
      VOICE + '\n' +
      'Return JSON only, no prose:\n' +
      '{"blurb":"one sentence under 24 words on what this field studies",' +
      '"example":{"title":"short label for the example","text":"2-3 sentences stating it"},' +
      '"children":[{"name":"Subfield Name","demand":"what the example needs here"}]}';
    return await askJSON(prompt, DRAFT_ROUTE, 'default', 1800);
  }

  // ---------- shared state ----------
  var state = { trail: [], children: {}, examples: {} };
  var el = {};

  function key(s){ return String(s||'').trim().toLowerCase(); }
  function esc(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function current(){ return state.trail[state.trail.length-1]; }
  function slug(s){ return key(s).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function unslug(sl){
    var t = String(sl||'').replace(/-/g,' ').trim();
    if (!t) return '';
    return t.replace(/\b[a-z]/g, function(c){ return c.toUpperCase(); });
  }

  function setStatus(m){
    if (!el.status) return;
    el.status.innerHTML = m ? '<div class="status"><span class="dot"></span><span>'+esc(m)+'</span></div>' : '';
  }
  function setError(m){
    if (!el.status) return;
    el.status.innerHTML = '<div class="err">'+esc(m)+'</div>';
  }
  function friendly(e, what){
    var c = e && e.code;
    if (c === 'not_granted') return 'Claude access was declined, so only the built-in fields are available.';
    if (c === 'rate_limited' || (e && e.http === 429)) return 'Rate limited. Give it a minute and try again.';
    if (c === 'cancelled') return 'Cancelled.';
    return 'Could not ' + what + '. ' + (e && e.message ? e.message : 'Try again.');
  }

  // ---------- shared chrome ----------
  function renderCrumbs(){
    if (!el.crumbs) return;
    el.crumbs.innerHTML = state.trail.map(function(nm,i){
      var sep = i ? '<span class="sep">→</span>' : '';
      return sep + (i === state.trail.length-1
        ? '<span class="here">'+esc(nm)+'</span>'
        : '<button type="button" data-i="'+i+'">'+esc(nm)+'</button>');
    }).join('');
  }

  function renderExample(ex){
    if (!el.exampleBlock) return;
    if (!ex || !ex.text){ el.exampleBlock.hidden = true; return; }
    el.exampleBlock.hidden = false;
    el.exTitle.textContent = ex.title || 'Running example';
    el.exText.textContent  = ex.text;
  }

  function renderChildren(kids){
    if (!el.chips) return;
    if (!kids || !kids.length){ el.childBlock.hidden = true; return; }
    el.childBlock.hidden = false;
    el.subLabel.textContent = 'What the example demands';
    el.chips.innerHTML = kids.map(function(c){
      var why = c.demand || c.blurb || '';
      return '<li><button type="button" class="chip" data-name="'+esc(c.name)+'">'+
             '<b>'+esc(c.name)+'</b>'+(why?'<i>'+esc(why)+'</i>':'')+'</button></li>';
    }).join('');
  }

  function syncCrossLink(){
    if (!el.crossLink) return;
    var s = slug(current() || '');
    var base = el.crossLink.getAttribute('data-page');
    el.crossLink.setAttribute('href', base + (s ? '#' + s : ''));
  }

  // ---------- navigation ----------
  var onNode = function(){};

  async function go(name, resetTo, skipHash){
    var k = key(name);
    if (!k) return;

    if (typeof resetTo === 'number') state.trail = state.trail.slice(0, resetTo+1);
    else if (!(state.trail.length && key(current()) === k)) state.trail.push(name);
    if (!state.trail.length) state.trail = [name];

    var label = current(), seed = SEED[k];
    if (el.nodeName)  el.nodeName.textContent = label;
    if (el.nodeBlurb){
      el.nodeBlurb.textContent = seed && seed.blurb ? seed.blurb : '';
      el.nodeBlurb.hidden = !el.nodeBlurb.textContent;
    }
    renderCrumbs();
    syncCrossLink();
    if (!skipHash){
      try { history.replaceState(null, '', '#' + slug(label)); } catch (e) {}
    }

    var ex = state.examples[k] || (seed && seed.example) || null;
    if (!ex && state.trail.length > 1) ex = state.examples[key(state.trail[state.trail.length-2])] || null;
    state.examples[k] = ex;
    renderExample(ex);

    onNode(label, k);

    if (state.children[k]) { renderChildren(state.children[k]); setStatus(''); }
    else if (seed) { state.children[k] = seed.children; renderChildren(seed.children); setStatus(''); }
    else {
      if (el.childBlock) el.childBlock.hidden = true;
      setStatus('Working out how ' + label + ' divides up…');
      try {
        var res = await askChildren(label);
        if (res && res.children && res.children.length){
          state.children[k] = res.children;
          if (res.example){ state.examples[k] = res.example; renderExample(res.example); }
          if (res.blurb && el.nodeBlurb && !el.nodeBlurb.textContent){
            el.nodeBlurb.textContent = res.blurb; el.nodeBlurb.hidden = false;
          }
          renderChildren(res.children);
          setStatus('');
        } else {
          setError('Nothing came back for that. Try a broader name, or one of the fields listed above.');
        }
      } catch (e) { setError(friendly(e, 'map that field')); }
    }
  }

  // ---------- boot ----------
  function boot(opts){
    opts = opts || {};
    onNode = opts.onNode || function(){};

    (opts.ids || []).concat(
      ['crumbs','nodeName','nodeBlurb','exampleBlock','exTitle','exText','chips',
       'childBlock','subLabel','status','actions','seekForm','q','crossLink']
    ).forEach(function(id){ el[id] = document.getElementById(id); });

    if (el.chips) el.chips.addEventListener('click', function(ev){
      var b = ev.target.closest('.chip'); if (b) go(b.getAttribute('data-name'));
    });
    if (el.crumbs) el.crumbs.addEventListener('click', function(ev){
      var b = ev.target.closest('button[data-i]');
      if (b) go(state.trail[+b.getAttribute('data-i')], +b.getAttribute('data-i'));
    });
    if (el.seekForm) el.seekForm.addEventListener('submit', function(ev){
      ev.preventDefault();
      var v = el.q.value.trim(); if (!v) return;
      state.trail = []; go(v); el.q.value = '';
    });

    // deep link: story.html#separation-logic and example.html#separation-logic
    var h = (location.hash || '').replace(/^#/, '');
    var startName = 'Logic';
    if (h){
      var want = h.replace(/-/g,' ');
      var hit = Object.keys(SEED).filter(function(sk){ return sk === want; })[0];
      if (hit) startName = unslug(h);
      else {
        // a child of a seeded field keeps its proper casing
        var found = null;
        Object.keys(SEED).forEach(function(sk){
          (SEED[sk].children || []).forEach(function(c){
            if (slug(c.name) === h){ found = c.name; state.examples[key(c.name)] = SEED[sk].example; }
          });
        });
        startName = found || unslug(h);
      }
    }
    state.trail = [];
    go(startName, undefined, true);
  }

  global.L = {
    esc: esc, key: key, slug: slug, current: current,
    state: state, el: el, SEED: SEED,
    setStatus: setStatus, setError: setError, friendly: friendly,
    askJSON: askJSON, backend: backend, routeName: routeName,
    VOICE: VOICE, DRAFT_ROUTE: DRAFT_ROUTE, AUDIT_ROUTE: AUDIT_ROUTE,
    go: go, boot: boot, renderChildren: renderChildren
  };

})(window);
