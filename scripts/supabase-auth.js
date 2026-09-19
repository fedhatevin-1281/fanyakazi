(function () {
  var config = window.FANYAKAZI_CONFIG || {};
  var isConfigured = config.supabaseUrl && !config.supabaseUrl.includes('your-project') &&
    config.supabaseAnonKey && !config.supabaseAnonKey.includes('your-anon-key');
  var client = isConfigured && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
    : null;
  window.fanyakaziSupabase = client;

  function normalizePhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.indexOf('0') === 0) digits = '254' + digits.slice(1);
    return digits ? '+' + digits : '';
  }

  function validPhone(value) {
    var phone = normalizePhone(value);
    return /^\+\d{9,15}$/.test(phone) ? phone : '';
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
      ? String(value).trim().toLowerCase()
      : '';
  }

  function messageFor(error) {
    if (!error) return 'Something went wrong. Please try again.';
    if (/invalid login credentials/i.test(error.message)) return 'Email/phone or password is incorrect.';
    if (/already registered|already been registered/i.test(error.message)) return 'That email or phone number is already registered.';
    return error.message || 'Something went wrong. Please try again.';
  }

  function showToast(message) {
    var toast = document.getElementById('db-toast');
    if (toast && window.showToast) window.showToast('error', message);
    else window.alert(message);
  }

  function showSignupSuccess(hasSession) {
    if (window.showSignupSuccess) {
      window.showSignupSuccess(hasSession);
      return;
    }
    window.alert(hasSession ? 'Account created successfully.' : 'Check your email to verify your account.');
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

  async function redirectAfterAuth() {
    if (!client) return;
    try {
      var sessionResult = await client.auth.getSession();
      var session = sessionResult.data.session;
      if (!session) return;
      var response = await fetch((config.apiBaseUrl || '') + '/api/work/overview', {
        headers: { Authorization: 'Bearer ' + session.access_token }
      });
      var payload = await response.json();
      if (!response.ok) return;
      window.location.href = payload && payload.programs && payload.programs.length ? '/work' : '../user/activate.html';
    } catch (error) {
      return;
    }
  }

  function readValue(id) {
    var field = document.getElementById(id);
    return field ? field.value.trim() : '';
  }

  var loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!requireConfig()) return;
    var identifier = readValue('phone');
    var password = readValue('password');
    var email = validEmail(identifier);
    var phone = email ? '' : validPhone(identifier);
    if ((!email && !phone) || !password) return showToast('Enter a valid email or phone number and password.');
    var button = document.getElementById('loginBtn');
    setLoading(button, true);
    try {
      var result = await client.auth.signInWithPassword(email
        ? { email: email, password: password }
        : { phone: phone, password: password });
      if (result.error) return showToast(messageFor(result.error));
      await redirectAfterAuth();
    } catch (error) {
      showToast(messageFor(error));
    } finally {
      setLoading(button, false);
    }
  });

  var registerForm = document.getElementById('registerForm');
  if (registerForm) registerForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var terms = document.getElementById('termsCheck');
    var username = readValue('username');
    var email = validEmail(readValue('email'));
    var phone = validPhone(readValue('phone'));
    var password = readValue('password');
    var country = readValue('country');
    if (username.length < 3 || username.length > 40) return showToast('Username must be 3 to 40 characters.');
    if (!email) return showToast('Enter a valid email address.');
    if (!phone) return showToast('Enter a valid phone number.');
    if (password.length < 6 || password.length > 128) return showToast('Password must be 6 to 128 characters.');
    if (!country) return showToast('Select your country.');
    if (!terms || !terms.checked) return showToast('Please accept the Terms of Service.');
    if (!requireConfig()) return;
    var button = document.getElementById('submitBtn');
    setLoading(button, true);
    try {
      var result = await client.auth.signUp({
        email: email,
        password: password,
        options: {
          data: {
            username: username,
            phone: phone,
            email: email,
            country: country
          }
        }
      });
      if (result.error) return showToast(messageFor(result.error));
      showSignupSuccess(Boolean(result.data.session));
      if (result.data.session) {
        setTimeout(async function () {
          await redirectAfterAuth();
        }, 1800);
      }
    } catch (error) {
      showToast(messageFor(error));
    } finally {
      setLoading(button, false);
    }
  });
})();