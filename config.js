// Settings for the "My inventory" page. These come from your Bungie app page:
// https://www.bungie.net/en/Application
// It's normal for these to be public. Bungie only accepts them from your site's address
// (the Origin Header you set on the app).
window.ROLL_SCORER_CONFIG = {
  bungieApiKey: '36ace87d87704e00ae3c93f00b2901f5',
  bungieClientId: '55110',
  // Lets signed-in players switch a weapon's perks from the site. Needs the
  // "Move or equip Destiny gear and other items" scope ticked on the Bungie app.
  // Set to false to turn the Apply buttons off.
  allowPerkChanges: true,
  // Votes on "Is this score right?". From Firebase console > Project settings > Your apps > Web app.
  // These are safe to be public; the rules you paste into Firestore decide what anyone can do.
  // Leave PASTE in place and the vote box stays hidden.
  firebase: {
    apiKey: 'AIzaSyCg8RTDO_TFE0vxfhQH9OtMZaSJch07LfA',
    authDomain: 'd2rollcheck.firebaseapp.com',
    projectId: 'd2rollcheck',
    appId: '1:693893018513:web:e2908455d7476db50d6030',
  },
};
