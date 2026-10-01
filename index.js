(function(){
  "use strict";
  var L = window.L;
  var el = L.el;

  L.boot({
    ids: ['toHistory','toExample'],
    showExample: false, showDemands: false, skipChildren: true,
    onNode: function(label){
      el.toHistory.textContent = 'Read how ' + label + ' got here';
      el.toExample.textContent = 'Work through a ' + label + ' example';
    }
  });
})();
