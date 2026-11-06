// Essai temporaire : le service peut-il ramener l'application Accueil devant ?
setTimeout(function () {
  tizen.application.launch('AccueilTV1.Accueil', function () {}, function () {});
}, 7000);
