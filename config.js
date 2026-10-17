/* ============================================================
   HOOP CONTEST — configurazione runtime (PC e Android)
   ------------------------------------------------------------
   "server" = indirizzo del server multiplayer pubblico.
   - Vuoto  -> su PC usa la stessa origine (npm start); se la
     pagina e' aperta da file, parte la modalita' offline.
   - In Android conviene SEMPRE impostarlo (URL stabile, es.
     deploy gratuito su Render): "https://tuo-servizio.onrender.com"
   Si puo' forzare anche via URL: index.html?ws=https://...
   Nessun servizio di tracciamento: solo l'indirizzo del gioco.
   ============================================================ */
window.HOOP_CONFIG = {
  server: ""
};
