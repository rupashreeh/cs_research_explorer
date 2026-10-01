(function(){
  "use strict";
  var L = window.L;
  var esc = L.esc, key = L.key, state = L.state, el = L.el;
  var askJSON = L.askJSON, backend = L.backend, routeName = L.routeName;
  var VOICE = L.VOICE, DRAFT_ROUTE = L.DRAFT_ROUTE, AUDIT_ROUTE = L.AUDIT_ROUTE;
  var setStatus = L.setStatus, setError = L.setError, friendly = L.friendly;
  var current = L.current;

  state.histories = {};

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function gatherPrompt(concept, area) {
  return 'You are a computer science research expert. Respond with a single raw JSON object and nothing else — no explanation, no markdown, no code fences, no text before or after the JSON.\n\n' +
    'Find 10-15 highly influential, REAL published papers about "' + concept + '" from top A* CS venues (' + AREA_DESCS[area] + ').\n' +
    'Papers MUST span from the earliest foundational work through to recent work (2020-2025). ' +
    'Include at least 2 papers from 2020-2025. Do not stop at 2010.\n' +
    'For each paper write a 1-2 sentence insight. Use **bold** for the key phrase.\n' +
    'Only include papers you are certain exist. Do not hallucinate.\n' +
    'For url: stable link (ACM DL, arXiv, USENIX, IEEE) or null.\n\n' +
    'Output ONLY this JSON, starting with { and ending with }:\n' +
    '{"papers":[{"title":"string","authors":"string","year":1985,"venue":"POPL","insight":"string","url":null}]}';
}

function mergeResults(settled, concept) {
  const map = new Map();
  for (let i = 0; i < settled.length; i++) {
    const src = settled[i];
    for (let j = 0; j < src.papers.length; j++) {
      const p = src.papers[j];
      const key = normTitle(p.title);
      if (!map.has(key)) {
        map.set(key, { title: p.title, authors: p.authors, year: p.year, venue: p.venue, insight: p.insight, url: p.url || null, sources: [src.label], sourceCount: 1 });
      } else {
        const ex = map.get(key);
        if (ex.sources.indexOf(src.label) === -1) {
          ex.sources.push(src.label);
          ex.sourceCount++;
          if ((p.insight || '').length > (ex.insight || '').length) ex.insight = p.insight;
          if (!ex.url && p.url) ex.url = p.url;
        }
      }
    }
  }

  const totalSources = settled.length;
  const papers = [];
  map.forEach(function(p) {
    p.confidence = (p.sourceCount === totalSources && totalSources > 1) ? 'all' : (p.sourceCount > 1 ? 'high' : 'medium');
    papers.push(p);
  });
  papers.sort(function(a, b) { return b.sourceCount - a.sourceCount || a.year - b.year; });

  return {
    concept: concept,
    sources_used: settled.map(function(s) { return s.label; }).join(' + '),
    total_candidates: settled.reduce(function(n, s) { return n + s.papers.length; }, 0),
    papers: papers
  };
}

async function lookupPaper(paper, signal) {
  const query = encodeURIComponent(paper.title);
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + query +
    '&limit=5&fields=title,authors,year,venue,externalIds,citationCount,openAccessPdf,paperId';
  try {
    const resp = await fetch(url, { signal: signal });
    if (!resp.ok) return null;
    const json = await resp.json();
    const results = json.data || [];
    if (!results.length) return null;

    const normQ = normTitle(paper.title);

    // Pass 1: exact normalised title match
    for (let i = 0; i < results.length; i++) {
      if (normTitle(results[i].title) === normQ) return results[i];
    }

    // Pass 2: one contains the other (handles subtitle truncation)
    for (let i = 0; i < results.length; i++) {
      const normR = normTitle(results[i].title);
      if (normR.includes(normQ) || normQ.includes(normR)) return results[i];
    }

    // Pass 3: word overlap >= 80% of query words
    const qWords = normQ.split(' ').filter(function(w) { return w.length > 2; });
    for (let i = 0; i < results.length; i++) {
      const normR = normTitle(results[i].title);
      const matches = qWords.filter(function(w) { return normR.indexOf(w) !== -1; }).length;
      if (qWords.length > 0 && matches / qWords.length >= 0.8) return results[i];
    }

    return null;
  } catch(e) {
    return null;
  }
}

async function validateUrl(url) {
  if (!url || url === 'null' || url === 'undefined') return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 5000);
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      mode: 'no-cors' // avoids CORS errors — we just want to know if it resolves
    });
    clearTimeout(timeout);
    // no-cors gives opaque response — if we get here without exception the URL resolved
    return true;
  } catch(e) {
    return false;
  }
}

async function verifyWithSemanticScholar(papers, signal) {
  // Rate limit: SS allows ~1 req/sec without API key — batch with small delays
  const results = [];
  for (let i = 0; i < papers.length; i++) {
    if (i > 0) await new Promise(function(r) { setTimeout(r, 200); });
    const paper = papers[i];
    const ss = await lookupPaper(paper, signal);
    if (ss) {
      const ssUrl = (ss.openAccessPdf && ss.openAccessPdf.url)
        ? ss.openAccessPdf.url
        : (ss.externalIds && ss.externalIds.DOI)
          ? 'https://doi.org/' + ss.externalIds.DOI
          : 'https://www.semanticscholar.org/paper/' + (ss.paperId || '');

      // Validate the URL actually loads before using it
      const urlWorks = await validateUrl(ssUrl);

      results.push(Object.assign({}, paper, {
        ssVerified:  true,
        url:         urlWorks ? ssUrl : null,
        ssCitations: ss.citationCount || 0,
        ssId:        ss.paperId || null
      }));
    } else {
      results.push(Object.assign({}, paper, {
        ssVerified:  false,
        ssCitations: null,
        ssId:        null
      }));
    }
  }
  return results;
}

  // ---------- find the papers, check them, then write from what survived ----------
  // Order matters. Papers are gathered and checked against Semantic Scholar
  // BEFORE the history is written, and the writer only sees what came back.
  // A paper that does not exist cannot be cited, because it is not on the list.

  var SOURCES = [
    { id:'gemini', route: '/gemini', label: 'Gemini' },
    { id:'groq',   route: '/groq',   label: 'Groq' }
  ];

  // ---- pipeline, same shape as the explorer's ----
  function showPipeline(steps){
    el.status.innerHTML = '<div class="pipeline"><div class="pipeline-title">Working</div>' +
      '<div class="pipeline-steps">' + steps.map(function(s){
        return '<div class="pipeline-step"><div class="step-icon pending" id="icon-'+s.id+'">·</div>' +
               '<div class="step-label"><strong>'+esc(s.label)+'</strong>' +
               '<div class="step-detail" id="detail-'+s.id+'">'+esc(s.detail)+'</div></div></div>';
      }).join('') + '</div></div>';
  }
  function step(id, stateName, detail){
    var i = document.getElementById('icon-'+id), d = document.getElementById('detail-'+id);
    if (i) i.className = 'step-icon ' + stateName;
    if (d && detail !== undefined) d.textContent = detail;
  }

  function gatherPrompt(field){
    return 'Find 12 to 18 real, published papers that matter for understanding "' + field + '" ' +
      'in computer science. Cover the whole span: the earliest work that set the problem up, ' +
      'through to the last few years. Include at least two from the past five years.\n\n' +
      'Only papers you are sure exist, with the authors and venue right. A half-remembered paper ' +
      'is worse than one fewer: every title here gets looked up in Semantic Scholar, and anything ' +
      'that does not match is thrown away before a reader sees it.\n\n' +
      'Return JSON only, no prose:\n' +
      '{"papers":[{"title":"","authors":"","year":1969,"venue":"POPL"}]}';
  }

  async function gatherFrom(src, field){
    step(src.id, 'running', 'Looking through the literature');
    try {
      var r = await askJSON(gatherPrompt(field), src.route, 'default', 3000);
      var ps = (r && r.papers) || [];
      step(src.id, ps.length ? 'done' : 'error', ps.length ? ps.length + ' suggested' : 'Nothing came back');
      return { label: src.label, papers: ps };
    } catch (e) {
      step(src.id, 'error', (e && e.message) ? e.message : 'Request failed');
      return { label: src.label, papers: [], error: e };
    }
  }

  // The history is written from the verified list only, cited by index.
  async function weave(field, papers, example){
    var list = papers.map(function(p, i){
      return i + '. ' + p.title + ' — ' + (p.authors || '?') + ', ' + (p.venue || '?') + ' ' + p.year;
    }).join('\n');

    var ex = example ? '\nThe reader may have come from this running example, so tie the account to ' +
      'it where it fits naturally. Do not force it.\n' + example.title + ' — ' + example.text + '\n' : '';

    var prompt =
      'Below are papers on "' + field + '" that have been checked and do exist. Write how this area ' +
      'developed, using only these papers.' + ex + '\n' +
      'Papers:\n' + list + '\n\n' +
      'Rules:\n' +
      '- Each beat is one move somebody made and the problem that forced it. Say what the previous ' +
      'approach could not do. That is the part worth reading.\n' +
      '- Cite by the number above, as a plain integer in "paper". Never invent one. Leave out any ' +
      'paper that does not fit the thread rather than forcing it in.\n' +
      '- Earliest first. 7 to 10 beats.\n\n' +
      VOICE + '\n' +
      'Return JSON only, no prose:\n' +
      '{"opening":"2-3 sentences on the problem this area started from",' +
      '"beats":[{"year":1969,"move":"short label under 7 words","text":"2-4 sentences","paper":0}],' +
      '"close":"1-2 sentences on what is still unsettled"}';

    return await askJSON(prompt, DRAFT_ROUTE, 'complex', 4000);
  }

  function paperLink(p){
    return p.url || ('https://www.semanticscholar.org/search?q=' + encodeURIComponent(p.title));
  }

  function renderHistory(st, papers, note){
    var h = '';
    if (st.opening) h += '<p class="opening">' + esc(st.opening) + '</p>';

    var used = {};
    var beats = (st.beats || []).filter(function(b){
      var ok = papers[b.paper] !== undefined;
      if (ok) used[b.paper] = true;
      return ok;
    });

    if (beats.length){
      h += '<ol class="spine">';
      beats.forEach(function(b){
        var p = papers[b.paper];
        h += '<li class="beat"><div class="beat-text">' +
          '<div class="yr">' + esc(b.year || p.year) + '</div>' +
          (b.move ? '<div class="move">' + esc(b.move) + '</div>' : '') +
          '<p>' + esc(b.text) + '</p></div>' +
          '<aside class="cite">' +
            '<p class="ct"><a href="' + esc(paperLink(p)) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a></p>' +
            (p.authors ? '<p class="ca">' + esc(p.authors) + '</p>' : '') +
            '<p class="cv"><span class="venue">' + esc(p.venue || 'paper') + '</span>' + esc(p.year) +
              (p.ssCitations != null ? ' · ' + Number(p.ssCitations).toLocaleString() + ' citations' : '') +
            '</p>' +
            '<p class="found">Found in Semantic Scholar</p>' +
          '</aside></li>';
      });
      h += '</ol>';
    }

    if (st.close) h += '<div class="closing"><b>Still unsettled</b>' + esc(st.close) + '</div>';

    var leftovers = papers.filter(function(p, i){ return !used[i]; });
    if (leftovers.length){
      h += '<details class="rest"><summary>' + leftovers.length +
           ' more papers that checked out but did not fit the thread</summary><ul>';
      leftovers.forEach(function(p){
        h += '<li><a href="' + esc(paperLink(p)) + '" target="_blank" rel="noopener">' + esc(p.title) +
             '</a> <span class="cv">' + esc(p.venue || '') + ' ' + esc(p.year) + '</span></li>';
      });
      h += '</ul></details>';
    }

    if (note) h += '<p class="checked">' + esc(note) + '</p>';
    el.history.innerHTML = h;
  }

  async function tellHistory(){
    var label = current(); if (!label) return;
    var k = key(label), cached = state.histories[k];
    if (cached){ el.status.innerHTML = ''; renderHistory(cached.st, cached.papers, cached.note); return; }

    if (el.goBtn) el.goBtn.disabled = true;
    el.history.innerHTML = '';
    showPipeline(SOURCES.map(function(s){ return {id:s.id, label:s.label, detail:'Waiting'}; })
      .concat([{id:'ss', label:'Semantic Scholar', detail:'Waiting for papers'},
               {id:'write', label:'Writing it up', detail:'Waiting for checked papers'}]));

    try {
      await backend();

      var got = await Promise.all(SOURCES.map(function(s){ return gatherFrom(s, label); }));
      var withPapers = got.filter(function(g){ return g.papers.length; });
      if (!withPapers.length){
        var why = got[0].error && got[0].error.message ? ' ' + got[0].error.message : '';
        setError('Neither model came back with papers for ' + label + '.' + why);
        return;
      }

      var merged = mergeResults(withPapers, label).papers;
      step('ss', 'running', 'Checking ' + merged.length + ' titles');
      var checked = await verifyWithSemanticScholar(merged, null);
      var verified = checked.filter(function(p){ return p.ssVerified; })
                            .sort(function(a,b){ return a.year - b.year; });
      var dropped = merged.length - verified.length;
      step('ss', verified.length ? 'done' : 'error',
           verified.length + ' found, ' + dropped + ' dropped');

      if (!verified.length){
        setError('None of the suggested papers turned up in Semantic Scholar, so there is nothing ' +
                 'here worth showing you. That usually means the field name was too narrow or too new.');
        return;
      }

      step('write', 'running', 'Using the ' + verified.length + ' that checked out');
      var st = await weave(label, verified, state.examples[k]);
      if (!st || !st.beats || !st.beats.length){
        step('write', 'error', 'Came back empty');
        setError('The papers checked out but the write-up came back empty. Worth another go.');
        return;
      }
      step('write', 'done', st.beats.length + ' turns in the story');

      var note = 'Two models suggested ' + merged.length + ' papers between them. ' + verified.length +
        ' were found in Semantic Scholar and ' + dropped +
        (dropped === 1 ? ' was dropped.' : ' were dropped.') +
        ' The history was written from the ones that survived, so every paper named here exists. ' +
        'Whether it says what the sentence beside it claims is still worth your own look.';

      state.histories[k] = { st: st, papers: verified, note: note };
      el.status.innerHTML = '';
      renderHistory(st, verified, note);
    } catch (e) {
      setError(friendly(e, 'put that history together'));
    } finally {
      if (el.goBtn) el.goBtn.disabled = false;
    }
  }

  L.boot({
    ids: ['history','goBtn'],
    showExample: false, showDemands: false,
    onNode: function(){
      el.history.innerHTML = '';
      el.status.innerHTML = '';
      el.actions.hidden = true;
      tellHistory();
    }
  });
  el.goBtn.addEventListener('click', function(){ el.actions.hidden = true; tellHistory(); });
})();
