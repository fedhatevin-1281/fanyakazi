(function () {
  var config = window.VISTAHUB_CONFIG || {};
  var isConfigured = config.supabaseUrl && !config.supabaseUrl.includes('your-project') &&
    config.supabaseAnonKey && !config.supabaseAnonKey.includes('your-anon-key');
  var client = isConfigured && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
    : null;
  window.vistahubSupabase = client;

  function normalizePhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.indexOf('0') === 0) digits = '254' + digits.slice(1);
    return digits ? '+' + digits : '';
  }

  function messageFor(error) {
    if (!error) return 'Something went wrong. Please try again.';
    if (/invalid login credentials/i.test(error.message)) return 'Phone number or password is incorrect.';
    if (/already registered|already been registered/i.test(error.message)) return 'That phone number is already registered.';
    return error.message || 'Something went wrong. Please try again.';
  }

  function showToast(message) {
    var toast = document.getElementById('db-toast');
    if (toast && window.showToast) window.showToast('error', message);
    else window.alert(message);
  }

  function setLoading(button, loading) {
    if (!button) return;
    button.classList.toggle('loading', loading);
    button.disabled = loading;
  }

  function requireConfig() {
    if (!client) {
      showToast('Supabase is not configured. Add the project URL and anon key in scripts/supabase-config.js.');
      return false;
    }
    return true;
  }

  var loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!requireConfig()) return;
    var button = document.getElementById('loginBtn');
    setLoading(button, true);
    var result = await client.auth.signInWithPassword({
      phone: normalizePhone(document.getElementById('phone').value),
      password: document.getElementById('password').value
    });
    setLoading(button, false);
    if (result.error) return showToast(messageFor(result.error));
    window.location.href = '../index.html';
  });

  var registerForm = document.getElementById('registerForm');
  if (registerForm) registerForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var terms = document.getElementById('termsCheck');
    if (!terms || !terms.checked) return;
    if (!requireConfig()) return;
    var button = document.getElementById('submitBtn');
    setLoading(button, true);
    var phone = normalizePhone(document.getElementById('phone').value);
    var result = await client.auth.signUp({
      phone: phone,
      password: document.getElementById('password').value,
      options: {
        data: {
          username: document.getElementById('username').value.trim(),
          phone: phone,
          country: document.getElementById('country').value
        }
      }
    });
    setLoading(button, false);
    if (result.error) return showToast(messageFor(result.error));
    if (!result.data.session) return showToast('Check your phone for the Supabase verification code, then sign in.');
    window.location.href = '../index.html';
  });
})();