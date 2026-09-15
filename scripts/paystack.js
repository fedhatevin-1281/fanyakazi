(function () {
  var config = window.VISTAHUB_CONFIG || {};

  window.startPaystackCheckout = async function (programSlug, amount) {
    var supabaseClient = window.vistahubSupabase;
    if (!supabaseClient) throw new Error('Supabase is not configured.');
    var sessionResult = await supabaseClient.auth.getSession();
    var session = sessionResult.data.session;
    if (!session) {
      window.location.href = '/pages/login.php.html';
      return;
    }
    var response = await fetch((config.apiBaseUrl || '') + '/api/paystack/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ programSlug: programSlug, amount: amount })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to start payment.');
    window.location.href = data.authorization_url;
  };
})();
