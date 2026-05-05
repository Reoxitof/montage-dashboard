/**
 * auth-token.js — Helper d'authentification par token (FiveM / sans cookies)
 *
 * Usage : inclure ce script dans toutes les pages qui font des appels API.
 * Il patch automatiquement window.fetch pour injecter le token Bearer.
 *
 * API publique :
 *   AuthToken.get()          → string | null
 *   AuthToken.set(token)     → void
 *   AuthToken.clear()        → void
 *   AuthToken.getUser()      → object | null
 *   AuthToken.isLoggedIn()   → bool
 *   AuthToken.logout()       → Promise<void>
 *   AuthToken.apiFetch(url, options) → Promise<Response>  (fetch avec token auto)
 */

(function () {
  "use strict";

  const STORAGE_KEY = "dashboard_token";
  const USER_KEY    = "dashboard_user";

  const AuthToken = {
    get() {
      try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
    },

    set(token) {
      try { localStorage.setItem(STORAGE_KEY, token); } catch {}
    },

    clear() {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(USER_KEY);
      } catch {}
    },

    getUser() {
      try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },

    setUser(user) {
      try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
    },

    isLoggedIn() {
      return !!this.get();
    },

    /**
     * fetch() avec injection automatique du token Bearer.
     * Utilise toujours cette méthode pour les appels API depuis FiveM / NUI.
     */
    async apiFetch(url, options = {}) {
      const token = this.get();
      const headers = new Headers(options.headers || {});

      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", "Bearer " + token);
      }

      // Toujours signaler qu'on est un client fetch (pas un browser form)
      if (!headers.has("X-Requested-With")) {
        headers.set("X-Requested-With", "fetch");
      }

      const res = await fetch(url, { ...options, headers });

      // Token expiré ou révoqué → nettoyer et rediriger
      if (res.status === 401) {
        const data = await res.clone().json().catch(() => ({}));
        if (data.error === "login_required" || data.error === "token_invalid") {
          this.clear();
          if (typeof window !== "undefined" && !window.location.pathname.includes("login")) {
            window.location.href = "/login.html?error=session_expirée";
          }
        }
      }

      return res;
    },

    /**
     * Déconnexion : révoque le token côté serveur + nettoie localStorage.
     */
    async logout() {
      const token = this.get();
      try {
        await this.apiFetch("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
      } catch {}
      this.clear();
      if (typeof window !== "undefined") {
        window.location.href = "/login.html";
      }
    },

    /**
     * Vérifie la session courante et met à jour les infos user.
     * Retourne null si non connecté.
     */
    async checkSession() {
      try {
        const res = await this.apiFetch("/auth/me");
        if (!res.ok) return null;
        const data = await res.json();
        if (data.user) {
          this.setUser(data.user);
          return data.user;
        }
        return null;
      } catch {
        return null;
      }
    }
  };

  // ── Patch global fetch pour injecter le token automatiquement ──
  // Uniquement pour les URLs relatives (appels API internes)
  const _originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init = {}) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));

    // Ne pas patcher les URLs externes ou les assets statiques
    const isInternal = url.startsWith("/") || url.startsWith(window.location.origin);
    const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|html)(\?|$)/.test(url);

    if (!isInternal || isAsset) {
      return _originalFetch(input, init);
    }

    const token = AuthToken.get();
    if (!token) return _originalFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));

    // Ne pas écraser un header Authorization déjà présent
    if (!headers.has("Authorization")) {
      headers.set("Authorization", "Bearer " + token);
    }
    if (!headers.has("X-Requested-With")) {
      headers.set("X-Requested-With", "fetch");
    }

    if (input instanceof Request) {
      return _originalFetch(new Request(input, { ...init, headers }));
    }
    return _originalFetch(input, { ...init, headers });
  };

  // Exposer globalement
  window.AuthToken = AuthToken;
})();
