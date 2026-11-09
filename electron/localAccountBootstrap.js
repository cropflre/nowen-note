async function requestLocalAccountBootstrap(request, secret, allowCreate) {
  try {
    const response = await request(
      "/auth/desktop/bootstrap-local",
      null,
      {
        "X-Nowen-Desktop-Secret": secret,
        "X-Nowen-Desktop-Allow-Create": allowCreate ? "1" : "0",
      },
    );
    if (response.status === 200 && response.data?.token && response.data?.user?.role === "admin") {
      return {
        account: {
          token: response.data.token,
          refreshToken: response.data.refreshToken,
          user: response.data.user,
        },
        reason: null,
      };
    }
    // Always a string: the reason is forwarded over IPC and shown to the user. A response without a
    // code (for example { error: "forbidden" }) is reported by its HTTP status.
    return { account: null, reason: response.data?.code || `HTTP_${response.status}` };
  } catch {
    return { account: null, reason: "BACKEND_UNAVAILABLE" };
  }
}

module.exports = { requestLocalAccountBootstrap };
