// Service TizenBrew : indique à l'application Accueil le port d'inspection de TizenBrew, qui change à chaque démarrage.
var http = require('http');
var fs = require('fs');

function portsEnEcoute() {
  var ports = [];
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (fichier) {
    var lignes;
    try { lignes = fs.readFileSync(fichier, 'utf8').split('\n').slice(1); } catch (e) { return; }
    lignes.forEach(function (ligne) {
      var c = ligne.trim().split(/\s+/);
      if (c[3] !== '0A' || !c[1]) return;
      var port = parseInt(c[1].split(':')[1], 16);
      if (port >= 30000 && ports.indexOf(port) < 0) ports.push(port);
    });
  });
  return ports;
}

function tester(port, suite) {
  var fini = false;
  var conclure = function (resultat) { if (!fini) { fini = true; suite(resultat); } };
  var req = http.get({ host: '127.0.0.1', port: port, path: '/json' }, function (res) {
    var texte = '';
    res.on('data', function (b) { texte += b; });
    res.on('end', function () {
      var pages;
      try { pages = JSON.parse(texte).filter(function (p) { return p.type === 'page'; }); } catch (e) { return conclure(null); }
      conclure(pages.length ? { port: port, ws: pages[0].webSocketDebuggerUrl, url: pages[0].url } : null);
    });
  });
  req.on('error', function () { conclure(null); });
  req.setTimeout(800, function () { req.abort(); conclure(null); });
}

function chercher(ports, suite) {
  if (!ports.length) return suite(null);
  tester(ports[0], function (r) { if (r) suite(r); else chercher(ports.slice(1), suite); });
}

var serveur = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  chercher(portsEnEcoute(), function (r) { res.end(JSON.stringify(r || {})); });
});
serveur.on('error', function () {});
serveur.listen(8099, '127.0.0.1');
