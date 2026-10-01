(function(){
  "use strict";
  var L = window.L;
  var esc = L.esc, key = L.key, state = L.state, el = L.el;
  var askJSON = L.askJSON, backend = L.backend, routeName = L.routeName;
  var VOICE = L.VOICE, DRAFT_ROUTE = L.DRAFT_ROUTE, AUDIT_ROUTE = L.AUDIT_ROUTE;
  var setStatus = L.setStatus, setError = L.setError, friendly = L.friendly;
  var current = L.current;

  state.stories = {};

  // One hand-written narrative, so the first screen shows the real thing
  // rather than a spinner. Threaded through the same transfer(a,b,n) example.
  var SEED_STORY = {
    "separation logic": {
      opening: "Hoare's rules let you write down what transfer(a, b, n) is supposed to do. They stop working the moment a and b might be the same account. The rules proceed by substitution, and substitution has to know which name refers to which cell. A heap will not tell you that. What follows is the long effort to reason about the part of memory you touched without first describing every part you did not.",
      beats: [
        {year:1969, move:"Programs get a proof system", text:"Hoare gave programs a calculus: a precondition, a command, a postcondition, with one rule per construct. You could finally state what transfer guarantees and check the claim. The assignment rule worked by substituting into the assertion, which quietly assumed every variable named its own location.", paper:{title:"An Axiomatic Basis for Computer Programming", authors:"C. A. R. Hoare", venue:"Communications of the ACM", year:1969}},
        {year:1972, move:"Pointers break substitution", text:"Burstall tried the same method on programs that follow pointers. It worked, but every specification grew a tail of clauses saying which pointers were not equal. For transfer you write a ≠ b by hand. For a linked structure you write it about everything, and the specification stops being readable.", paper:{title:"Some Provable Inductive Assertions About Programs That Alter Data Structures", authors:"R. M. Burstall", venue:"Machine Intelligence 7", year:1972}},
        {year:2001, move:"Disjointness moves into the connective", text:"Ishtiaq and O'Hearn took the separating conjunction from bunched implications and read it as a claim about the heap. P ∗ Q holds when the heap splits in two, P true of one half and Q of the other. Now a ≠ b is not a side condition you remember to write. It is what the connective means. The frame rule follows: if transfer touches only a and b, the rest of the heap is untouched and never has to be mentioned.", paper:{title:"BI as an Assertion Language for Mutable Data Structures", authors:"Samin Ishtiaq, Peter W. O'Hearn", venue:"POPL", year:2001}},
        {year:2002, move:"The system gets assembled", text:"Reynolds put the pieces together with a worked semantics and a set of examples — list reversal, trees, Schorr-Waite. The proofs stayed roughly the size of the code they described, which had not been true before. This is the paper people date the field from.", paper:{title:"Separation Logic: A Logic for Shared Mutable Data Structures", authors:"John C. Reynolds", venue:"LICS", year:2002}},
        {year:2004, move:"Ownership handles threads", text:"If a thread owns a piece of heap, nothing else can interfere with it. Concurrent reasoning then reduces to bookkeeping about who owns what and when ownership moves. Two threads running transfer on disjoint accounts need no reasoning about each other at all. Brookes supplied the soundness proof the same year.", paper:{title:"Resources, Concurrency and Local Reasoning", authors:"Peter W. O'Hearn", venue:"CONCUR", year:2004}},
        {year:2009, move:"The preconditions infer themselves", text:"Until this point somebody had to write the precondition before any analysis could start, which kept the method among people who already understood the proof. Bi-abduction infers the missing precondition and the leftover frame together. That let it run over code nobody had annotated, which is how it ended up inside Facebook's Infer.", paper:{title:"Compositional Shape Analysis by Means of Bi-Abduction", authors:"Cristiano Calcagno, Dino Distefano, Peter W. O'Hearn, Hongseok Yang", venue:"POPL", year:2009}},
        {year:2015, move:"A dozen logics become one", text:"By 2015 there were many concurrent separation logics, each with its own hard-coded notion of permission or protocol. Iris showed they are instances of one construction: user-defined partial commutative monoids plus invariants, mechanised in Coq. You stop inventing a logic per problem and instantiate the same one.", paper:{title:"Iris: Monoids and Invariants as an Orthogonal Basis for Concurrent Reasoning", authors:"Ralf Jung, David Swasey, Filip Sieczkowski, Kasper Svendsen, Aaron Turon, Lars Birkedal, Derek Dreyer", venue:"POPL", year:2015}},
        {year:2018, move:"A shipping language gets checked", text:"Rust's safety argument has a gap: the standard library's internals use unsafe code the type system cannot justify on its own. RustBelt closed it in Iris, proving the ownership discipline sound including those internals. A production language had its central claim mechanically checked.", paper:{title:"RustBelt: Securing the Foundations of the Rust Programming Language", authors:"Ralf Jung, Jacques-Henri Jourdan, Robbert Krebbers, Derek Dreyer", venue:"POPL", year:2018}}
      ],
      open: "All of this assumes one heap on one machine, where two things are separate because their addresses differ. Replicate that account across machines and the question changes shape. Separateness is no longer about addresses but about which operations commute. What plays the part of the frame rule there is still open."
    }
  };

  async function askStory(field, trail, example){
    var ctx = trail.length > 1 ? ' It sits within ' + trail.slice(0,-1).join(' → ') + '.' : '';
    var ex = example
      ? '\nCarry this running example through the whole narrative, returning to it at each turn so the ' +
        'reader sees what each step made possible that the previous one could not:\n' +
        example.title + ' — ' + example.text + '\n'
      : '';
    var prompt =
      'Write the intellectual history of "' + field + '" in computer science as a sequence of turning points.' +
      ctx + ex + '\n' +
      'Each beat is one specific move somebody made, and the problem that forced it. Say what the ' +
      'previous approach could not do. 6 to 9 beats, earliest first.\n\n' +
      'Cite only papers you are confident exist, with correct authors, venue and year. Prefer canonical ' +
      'ones. A citation you are unsure about is worse than none: a separate model and Semantic Scholar ' +
      'will both check these, and wrong ones will be shown to the reader as wrong.\n\n' +
      VOICE + '\n' +
      'Return JSON only, no prose:\n' +
      '{"opening":"2-3 sentences stating the problem the field began from, in terms of the example",' +
      '"beats":[{"year":1969,"move":"short label under 7 words",' +
      '"text":"2-4 sentences","paper":{"title":"","authors":"","venue":"","year":1969}}],' +
      '"open":"1-2 sentences on what is still unresolved"}';
    return await askJSON(prompt, DRAFT_ROUTE, 'complex', 4000);
  }

  // Second model. Sees the claims and citations, not the reasoning that produced them.
  async function askAudit(field, beats){
    var items = beats.map(function(b,i){
      var p = b.paper || {};
      return { i:i, title:p.title, authors:p.authors, venue:p.venue, year:p.year, claim:b.text };
    });
    var prompt =
      'Another model drafted a history of "' + field + '" and attached a citation to each claim. ' +
      'Audit the citations. You are the check on its mistakes, so be sceptical. Confirming a paper ' +
      'that does not exist is the worst outcome here.\n\n' +
      'For each entry decide:\n' +
      '"confirmed" — the paper exists, authors, venue and year are right, and it supports the claim.\n' +
      '"doubtful" — real paper, but a detail is off or it does not really support the claim.\n' +
      '"wrong" — you do not believe this paper exists, or it is badly misattributed.\n\n' +
      'Prefer "doubtful" to guessing. Each note under 22 words, saying what specifically is off.\n\n' +
      'Entries:\n' + JSON.stringify(items) + '\n\n' +
      'Return JSON only, no prose:\n{"verdicts":[{"i":0,"status":"confirmed","note":""}]}';
    return await askJSON(prompt, AUDIT_ROUTE, 'default', 2500);
  }

  // ---------- Semantic Scholar ----------
  function norm(s){
    return String(s||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  }
  function titleClose(a,b){
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    var aw = a.split(' '), bw = new Set(b.split(' '));
    var hit = aw.filter(function(w){ return w.length > 3 && bw.has(w); }).length;
    var denom = aw.filter(function(w){ return w.length > 3; }).length || 1;
    return hit / denom;
  }
  function surnames(s){
    return String(s||'').split(/,| and /).map(function(n){
      var parts = n.trim().split(/\s+/);
      return norm(parts[parts.length-1]);
    }).filter(Boolean);
  }

  async function checkS2(paper){
    if (!paper || !paper.title) return { status:'unchecked' };
    var url = S2 + '?limit=3&fields=title,year,venue,authors,citationCount,externalIds,url&query=' +
              encodeURIComponent(paper.title);
    var r;
    try { r = await fetch(url, { headers:{ 'Accept':'application/json' } }); }
    catch (e) { return { status:'unavailable' }; }          // CSP-blocked inside an artifact
    if (r.status === 429) return { status:'ratelimited' };
    if (!r.ok) return { status:'unavailable' };

    var j = await r.json().catch(function(){ return null; });
    if (!j || !j.data || !j.data.length) return { status:'absent' };

    var best = null, bestScore = 0;
    j.data.forEach(function(c){
      var sc = titleClose(paper.title, c.title);
      if (sc > bestScore) { bestScore = sc; best = c; }
    });
    if (!best || bestScore < 0.6) return { status:'absent' };

    var notes = [];
    if (paper.year && best.year && Math.abs(+paper.year - +best.year) > 1)
      notes.push('year given as ' + paper.year + ', Semantic Scholar has ' + best.year);

    var claimed = surnames(paper.authors);
    var actual = (best.authors||[]).map(function(a){ return norm(a.name).split(' ').pop(); });
    if (claimed.length && actual.length){
      var overlap = claimed.filter(function(s){ return actual.indexOf(s) > -1; }).length;
      if (!overlap) notes.push('none of the named authors match the record');
    }

    return {
      status: notes.length ? 'mismatch' : 'found',
      note: notes.join('; '),
      title: best.title,
      year: best.year,
      venue: best.venue,
      citations: best.citationCount,
      url: best.url || (best.externalIds && best.externalIds.DOI
            ? 'https://doi.org/' + best.externalIds.DOI : null)
    };
  }

  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  async function checkAllS2(beats, onProgress){
    var out = [];
    for (var i = 0; i < beats.length; i++){
      out.push(await checkS2(beats[i].paper));
      if (onProgress) onProgress(i + 1, beats.length);
      if (out[i].status === 'unavailable') {            // blocked outright; stop hammering
        while (out.length < beats.length) out.push({ status:'unavailable' });
        break;
      }
      if (i < beats.length - 1) await sleep(360);       // stay under the public rate limit
    }
    return out;
  }

  function verdictMarkup(v){
    if (!v) return '';
    var s2 = v.s2, au = v.audit, rows = '';

    if (s2){
      if (s2.status === 'found'){
        rows += '<span class="vtag ok">Semantic Scholar · found</span>'+
                '<span class="vnote">'+esc(s2.title)+
                (s2.citations != null ? ' · '+Number(s2.citations).toLocaleString()+' citations' : '')+'</span>';
      } else if (s2.status === 'mismatch'){
        rows += '<span class="vtag doubt">Semantic Scholar · detail off</span>'+
                '<span class="vnote">'+esc(s2.note)+'</span>';
      } else if (s2.status === 'absent'){
        rows += '<span class="vtag bad">Semantic Scholar · no match</span>'+
                '<span class="vnote">Nothing with this title came back. Treat as unverified.</span>';
      } else if (s2.status === 'ratelimited'){
        rows += '<span class="vtag doubt">Semantic Scholar · rate limited</span>';
      } else if (s2.status === 'unavailable'){
        rows += '<span class="vtag doubt">Semantic Scholar · not reachable here</span>';
      }
    }

    if (au && au.status){
      var cls = au.status === 'confirmed' ? 'ok' : au.status === 'wrong' ? 'bad' : 'doubt';
      var label = au.status === 'confirmed' ? 'supports the claim'
                : au.status === 'wrong' ? 'disputed' : 'doubtful';
      rows += '<span class="vtag '+cls+'" style="margin-top:6px">'+esc(au.by||'Cross-check')+' · '+label+'</span>';
      if (au.note) rows += '<span class="vnote">'+esc(au.note)+'</span>';
    }

    return rows ? '<div class="verdict">'+rows+'</div>' : '';
  }

  function cardClass(v){
    if (!v) return '';
    if ((v.s2 && v.s2.status === 'absent') || (v.audit && v.audit.status === 'wrong')) return ' wrong';
    if ((v.s2 && v.s2.status === 'mismatch') || (v.audit && v.audit.status === 'doubtful')) return ' doubtful';
    return '';
  }

  function renderStory(st, verdicts, checkedLine){
    if (!st){ el.story.innerHTML=''; return; }
    var html = '';
    if (st.opening) html += '<p class="opening">'+esc(st.opening)+'</p>';
    var beats = st.beats || [];
    if (beats.length){
      html += '<ol class="spine">';
      beats.forEach(function(b,i){
        var p = b.paper || {}, v = verdicts ? verdicts[i] : null;
        var qs = encodeURIComponent(p.title||'');
        var s2url = (v && v.s2 && v.s2.url) ? v.s2.url
                  : 'https://www.semanticscholar.org/search?q='+qs;
        html += '<li class="beat"><div class="beat-text">'+
          (b.year?'<div class="yr">'+esc(b.year)+'</div>':'')+
          (b.move?'<div class="move">'+esc(b.move)+'</div>':'')+
          '<p>'+esc(b.text)+'</p></div>'+
          (p.title
            ? '<aside class="cite'+cardClass(v)+'">'+
                '<p class="ct">'+esc(p.title)+'</p>'+
                (p.authors?'<p class="ca">'+esc(p.authors)+'</p>':'')+
                '<p class="cv">'+esc([p.venue,p.year].filter(Boolean).join(' · '))+'</p>'+
                '<div class="links">'+
                  '<a href="'+esc(s2url)+'" target="_blank" rel="noopener">Semantic Scholar</a>'+
                  '<a href="https://scholar.google.com/scholar?q='+qs+'" target="_blank" rel="noopener">Google Scholar</a>'+
                '</div>'+
                verdictMarkup(v)+
              '</aside>'
            : '<aside></aside>')+
          '</li>';
      });
      html += '</ol>';
    }
    if (st.open) html += '<div class="closing"><b>Still open</b>'+esc(st.open)+'</div>';
    if (checkedLine) html += '<p class="checked">'+esc(checkedLine)+'</p>';
    el.story.innerHTML = html;
  }

  async function tellStory(){
    var label = current(); if (!label) return;
    var k = key(label), cached = state.stories[k];
    if (cached){ renderStory(cached.story, cached.verdicts, cached.line); return; }

    el.tellStory.disabled = true;
    try {
      await backend();
      var drafter = routeName(DRAFT_ROUTE), auditor = routeName(AUDIT_ROUTE);

      setStatus(drafter + ' is drafting the history of ' + label + '…');
      var st = await askStory(label, state.trail, state.examples[k]);
      if (!st || !st.beats || !st.beats.length){
        setError('No usable history came back for ' + label + '. Try a more specific subfield.');
        return;
      }

      // show the draft immediately, then fill verdicts in as they land
      renderStory(st, null, null);

      var verdicts = st.beats.map(function(){ return {}; });

      setStatus('Checking ' + st.beats.length + ' citations against Semantic Scholar…');
      var s2 = await checkAllS2(st.beats, function(done, total){
        setStatus('Checking citations against Semantic Scholar… ' + done + ' of ' + total);
      });
      s2.forEach(function(r,i){ verdicts[i].s2 = r; });
      renderStory(st, verdicts, null);

      var auditName = (mode === 'claude') ? 'Second pass' : auditor;
      setStatus(auditName + ' is auditing whether each paper supports its claim…');
      try {
        var au = await askAudit(label, st.beats);
        if (au && au.verdicts){
          au.verdicts.forEach(function(v){
            if (verdicts[v.i]) verdicts[v.i].audit = { status:v.status, note:v.note, by:auditName };
          });
        }
      } catch (e) { /* audit is best-effort; the S2 result still stands */ }

      var reachable = s2.some(function(r){ return r.status !== 'unavailable'; });
      var line = 'Drafted by ' + drafter + ', audited by ' + auditName +
        (reachable ? ', citations checked against Semantic Scholar.'
                   : '. Semantic Scholar could not be reached from this page, so citation existence is unverified here.') +
        ' Google Scholar has no API and blocks automated queries, so that link is for you to check by hand.';

      state.stories[k] = { story: st, verdicts: verdicts, line: line };
      renderStory(st, verdicts, line);
      setStatus('');
    } catch (e) {
      setError(friendly(e, 'trace that history'));
    } finally {
      el.tellStory.disabled = false;
    }
  }

  L.boot({
    ids: ['story','tellStory'],
    onNode: function(label, k){
      el.story.innerHTML = '';
      el.tellStory.textContent = 'Tell the story of ' + label;
      el.actions.hidden = false;
      if (SEED_STORY[k]){
        state.stories[k] = { story: SEED_STORY[k], verdicts: null, line: null };
        renderStory(SEED_STORY[k], null, null);
      }
    }
  });
  el.tellStory.addEventListener('click', tellStory);
})();
