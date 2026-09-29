(function registerIntegratedEmail(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.IntegratedEmail = api.create({
    fetchImpl: root.fetch.bind(root)
  });
})(typeof window !== 'undefined' ? window : globalThis, function createEmailServiceModule() {
  'use strict';

  const ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
  const CONFIG = Object.freeze({
    serviceId: 'service_jir4xnh',
    publicKey: 'aGIutKhexZ-690rIq',
    templates: Object.freeze({
      checklog: 'template_a286ybv',
      newsletter: 'template_zr1cbgb'
    })
  });

  function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Informe um e-mail válido para o envio.');
    }
    return email;
  }

  function requireText(value, fieldName) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`Informe ${fieldName} para o envio.`);
    return text;
  }

  function create({ fetchImpl, timeoutMs = 12000, abortControllerFactory = () => new AbortController() } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('O recurso de envio de e-mail não está disponível neste navegador.');
    }

    async function sendTemplate(templateId, templateParams) {
      const controller = abortControllerFactory();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            service_id: CONFIG.serviceId,
            template_id: templateId,
            user_id: CONFIG.publicKey,
            template_params: templateParams
          })
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('O envio do e-mail excedeu o tempo limite. Tente novamente.');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`EmailJS (${response.status}): ${responseText || 'falha no envio'}`);
      }

      return responseText;
    }

    return {
      async sendNewsletterWelcome(email) {
        return sendTemplate(CONFIG.templates.newsletter, {
          user_email: normalizeEmail(email)
        });
      },

      async sendCheckLogWelcome({ email, name, role }) {
        return sendTemplate(CONFIG.templates.checklog, {
          user_email: normalizeEmail(email),
          user_name: requireText(name, 'o nome do colaborador'),
          user_role: requireText(role, 'o cargo do colaborador')
        });
      }
    };
  }

  return { CONFIG, create };
});
