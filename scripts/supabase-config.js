/* These values are safe to expose in the browser; protect service-role keys on the server. */
window.FANYAKAZI_CONFIG = {
  supabaseUrl: 'https://ucwijygbgfesohrchlme.supabase.co',
  supabaseAnonKey: 'sb_publishable_cEtHBvnKjJ_3wQX3UG542A_-zCnlNNH',
  apiBaseUrl: /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
    ? 'http://localhost:3000'
    : window.location.origin
};