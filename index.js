(function(){
  "use strict";
  var L = window.L;
  var esc = L.esc, key = L.key, state = L.state, el = L.el;
  var askJSON = L.askJSON, backend = L.backend, routeName = L.routeName;
  var VOICE = L.VOICE, DRAFT_ROUTE = L.DRAFT_ROUTE, AUDIT_ROUTE = L.AUDIT_ROUTE;
  var setStatus = L.setStatus, setError = L.setError, friendly = L.friendly;
  var current = L.current;

  L.boot({
    ids: [],
    showExample: true, showDemands: true,
    onNode: function(label){
      el.actions.hidden = false;
      document.getElementById('lead').textContent =
        'Everything below is framed around one example. Pick a subfield to go deeper, or follow ' +
        'a link to read how ' + label + ' got here or work the example through.';
    }
  });
})();
