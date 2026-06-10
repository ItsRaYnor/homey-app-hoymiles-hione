'use strict';

const HoymilesApi = require('./lib/HoymilesApi');

module.exports = {

  /**
   * Verify S-Miles Cloud credentials and store them for pairing.
   * Called from the app settings page.
   */
  async testLogin({ homey, body }) {
    const email    = (body && body.email    || '').trim();
    const password = (body && body.password || '');
    if (!email || !password) throw new Error('Email and password are required');

    const api = new HoymilesApi({
      log:     (...args) => homey.app.log(...args),
      error:   (...args) => homey.app.error(...args),
      baseUrl: homey.settings.get('cloud_api_url') || undefined,
    });

    await api.login(email, password); // throws with details on failure

    homey.settings.set('saved_email', email);
    homey.settings.set('saved_password', password);
    return { email };
  },

  /**
   * Forget the stored S-Miles Cloud account.
   */
  async forgetLogin({ homey }) {
    homey.settings.unset('saved_email');
    homey.settings.unset('saved_password');
    return true;
  },

};
