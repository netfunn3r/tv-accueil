// Service TizenBrew : relais entre l'application Accueil et l'inspection de TizenBrew, dont le port change à chaque démarrage.
// La télé ignore un changement de page quand TizenBrew est en arrière-plan : le relais le met d'abord devant.
var http = require('http');
var fs = require('fs');
var net = require('net');
var crypto = require('crypto');

var ACCUEIL = 'AccueilTV1.Accueil';
var TIZENBREW = 'xvvl3S1bvH.TizenBrewStandalone';
var RELAIS = 'ws://127.0.0.1:8099/relais';

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

function lancer(id) {
  tizen.application.launch(id, function () {}, function () {});
}

/* ---------- WebSocket minimal, sans dépendance ---------- */

function lireTrame(b) {
  if (b.length < 2) return null;
  var long = b[1] & 0x7f;
  var dec = 2;
  if (long === 126) {
    if (b.length < 4) return null;
    long = b.readUInt16BE(2);
    dec = 4;
  } else if (long === 127) {
    if (b.length < 10) return null;
    long = b.readUInt32BE(6);
    dec = 10;
  }
  var masque = null;
  if (b[1] & 0x80) {
    if (b.length < dec + 4) return null;
    masque = b.slice(dec, dec + 4);
    dec += 4;
  }
  if (b.length < dec + long) return null;
  var charge = Buffer.from(b.slice(dec, dec + long));
  if (masque) for (var i = 0; i < charge.length; i++) charge[i] ^= masque[i % 4];
  return { op: b[0] & 0x0f, charge: charge, reste: b.slice(dec + long) };
}

function trameTexte(texte, masquer) {
  var charge = Buffer.from(texte);
  var tete = [0x81];
  var bit = masquer ? 0x80 : 0;
  if (charge.length < 126) tete.push(bit | charge.length);
  else tete.push(bit | 126, charge.length >> 8, charge.length & 255);
  if (!masquer) return Buffer.concat([Buffer.from(tete), charge]);
  var masque = crypto.randomBytes(4);
  for (var i = 0; i < charge.length; i++) charge[i] ^= masque[i % 4];
  return Buffer.concat([Buffer.from(tete), masque, charge]);
}

// Envoie des commandes à l'inspection de TizenBrew, puis referme.
function envoyerInspection(url, commandes, suite) {
  var m = /^ws:\/\/([^:\/]+):(\d+)(\/.*)$/.exec(url);
  if (!m) return suite();
  var fini = false;
  var conclure = function () { if (!fini) { fini = true; sock.destroy(); suite(); } };
  var recu = '';
  var pret = false;
  var sock = net.connect(Number(m[2]), m[1], function () {
    sock.write('GET ' + m[3] + ' HTTP/1.1\r\nHost: ' + m[1] + ':' + m[2] + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('data', function (d) {
    if (pret) return;
    recu += d.toString('latin1');
    if (recu.indexOf('\r\n\r\n') < 0) return;
    pret = true;
    commandes.forEach(function (c) { sock.write(trameTexte(JSON.stringify(c), true)); });
    setTimeout(conclure, 500);
  });
  sock.on('error', conclure);
  setTimeout(conclure, 4000);
}

/* ---------- Changement de page ---------- */

function hote(url) {
  var m = /^[a-z]+:\/\/(?:www\.)?([^\/:]+)/i.exec(url || '');
  return m ? m[1] : '';
}

function aller(url, touches) {
  var essais = 0;
  var tenter = function () {
    if (++essais > 4) return;
    lancer(TIZENBREW);
    setTimeout(function () {
      chercher(portsEnEcoute(), function (r) {
        if (!r) return setTimeout(tenter, 1500);
        if (hote(r.url) === hote(url)) return;
        var commandes = [];
        if (touches && r.url.indexOf('file:') === 0) commandes.push({ id: 1, method: 'Runtime.evaluate', params: { expression: touches } });
        commandes.push({ id: 2, method: 'Page.navigate', params: { url: url } });
        envoyerInspection(r.ws, commandes, function () {
          setTimeout(function () {
            chercher(portsEnEcoute(), function (v) { if (!v || hote(v.url) !== hote(url)) tenter(); });
          }, 3500);
        });
      });
    }, 900);
  };
  tenter();
}

/* ---------- Démarrage ---------- */

// Au premier démarrage, l'application Accueil se met en pause quand TizenBrew passe devant.
// Dès que TizenBrew est prêt, on la ramène : elle termine alors l'ouverture de la tuile choisie.
var essaisDemarrage = 0;
var attenteDemarrage = setInterval(function () {
  if (++essaisDemarrage > 45) { clearInterval(attenteDemarrage); return; }
  chercher(portsEnEcoute(), function (r) {
    if (!r) return;
    clearInterval(attenteDemarrage);
    if (r.url.indexOf('file:') === 0) setTimeout(function () { lancer(ACCUEIL); }, 1000);
  });
}, 2000);

/* ---------- Serveur ---------- */

var serveur = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  // La télé refuse les ordres venant d'un site : le module Anime-Sama passe par ici pour rouvrir l'accueil.
  if (req.url.indexOf('/accueil') === 0) {
    lancer(ACCUEIL);
    return res.end('{}');
  }
  chercher(portsEnEcoute(), function (r) {
    res.end(JSON.stringify(r ? { port: r.port, url: r.url, ws: RELAIS } : {}));
  });
});

// L'application croit parler à l'inspection : le relais reçoit ses commandes et les rejoue au bon moment.
serveur.on('upgrade', function (req, sock) {
  var accord = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accord + '\r\n\r\n');
  var tampon = Buffer.alloc(0);
  var touches = null;
  sock.on('error', function () {});
  sock.on('data', function (d) {
    tampon = Buffer.concat([tampon, d]);
    var t = lireTrame(tampon);
    while (t) {
      tampon = t.reste;
      if (t.op === 8) { sock.end(); return; }
      if (t.op === 1) {
        var m;
        try { m = JSON.parse(t.charge.toString('utf8')); } catch (e) { m = null; }
        if (m && m.method === 'Runtime.evaluate') touches = m.params.expression;
        if (m) sock.write(trameTexte(JSON.stringify({ id: m.id, result: {} }), false));
        if (m && m.method === 'Page.navigate') aller(m.params.url, touches);
      }
      t = lireTrame(tampon);
    }
  });
});

serveur.on('error', function () {});
serveur.listen(8099, '127.0.0.1');
