// Service TizenBrew : quand la télé sort de veille, rouvre TizenBrew, qui affiche alors l'accueil.
var http = require('http');

var APPLI = 'xvvl3S1bvH.TizenBrewStandalone';
var PERIODE_MS = 3000;
var etatPrecedent = null;
var dernierPassage = Date.now();

function ouvrir() {
  var req = http.request({ host: '127.0.0.1', port: 8001, path: '/api/v2/applications/' + APPLI, method: 'POST' });
  req.on('error', function () {});
  req.end();
}

setInterval(function () {
  var maintenant = Date.now();
  // Si la veille a figé ce service, le minuteur repart avec un grand retard.
  var fige = maintenant - dernierPassage > PERIODE_MS * 5;
  dernierPassage = maintenant;

  http.get('http://127.0.0.1:8001/api/v2/', function (res) {
    var texte = '';
    res.on('data', function (bout) { texte += bout; });
    res.on('end', function () {
      var etat;
      try { etat = JSON.parse(texte).device.PowerState; } catch (e) { return; }
      if (etat === 'on' && (etatPrecedent === 'standby' || fige)) ouvrir();
      etatPrecedent = etat;
    });
  }).on('error', function () {});
}, PERIODE_MS);
