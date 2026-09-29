import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
    getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    setPersistence, browserSessionPersistence, browserLocalPersistence, inMemoryPersistence,
    onAuthStateChanged, signOut, deleteUser
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
    getDatabase, ref, set, get, onValue, remove, query, orderByChild, equalTo, push, update, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
    calcularTempoTrabalhadoMs,
    chaveDeterministicaPonto,
    chaveDoRegistroPonto,
    dataOperacionalISO,
    prepararAplicacaoJustificativa,
    processamentoJustificativaExpirado,
    registroEntradaAtrasada,
    resolverRegistroOrigemNoHistorico,
    saldoBancoHorasMs,
    sessaoAutenticadaAtual,
    snapshotParaLista,
    validarSequenciaRegistros
} from './business-rules.js?v=1.5.2';
import {
    getPreference, getViewPreference, matchesSearch, paginate,
    setPreference, setViewPreference, sortItems, timestampNoPeriodoCalendario
} from './ui-experience.js?v=1.5.2';
import {
    montarDatasetPowerBi,
    serializarCsv
} from './power-bi-export.js?v=1.5.2';
import {
    buildStockArViewModel,
    createStockArCameraController,
    detectCameraSupport,
    getCameraUnavailableMessage
} from './stock-ar.js?v=1.5.2';

// ---------------------------------------------------------------------
// CARREGAMENTO MODULAR DAS TELAS
// ---------------------------------------------------------------------
// Cada tela vive em pages/*.html. O app aguarda todas elas antes de ligar
// eventos, autenticação e renderizações, evitando referências a elementos
// que ainda não existem no DOM.
const PAGE_MODULES = [
    'login',
    'cadastro',
    'pagina-inicial',
    'registrar_ponto',
    'meu-checklog',
    'gerenciamento-ponto',
    'justificativas',
    'controle-estoque',
    'fornecedores',
    'dashboard',
    'encomendar',
    'relatorios'
];

async function carregarModulosDePagina() {
    const host = document.getElementById('page-module-host');
    const loader = document.getElementById('page-module-loader');
    if (!host) throw new Error('O contêiner dos módulos não foi encontrado.');

    const modulos = await Promise.all(PAGE_MODULES.map(async pageId => {
        const response = await fetch(`./pages/${pageId}.html`, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Não foi possível carregar pages/${pageId}.html.`);
        }

        const source = await response.text();
        const pageDocument = new DOMParser().parseFromString(source, 'text/html');
        const page = pageDocument.getElementById(`page-${pageId}`);
        if (!page) throw new Error(`A tela ${pageId} não possui o ID esperado.`);

        page.classList.toggle('active', pageId === 'login');
        return page;
    }));

    const fragment = document.createDocumentFragment();
    modulos.forEach(page => fragment.appendChild(document.importNode(page, true)));
    host.replaceWith(fragment);
    loader?.remove();
}

const standalonePage = document.body.dataset.standalonePage;
if (standalonePage) {
    window.location.replace(new URL(`index.html#${standalonePage}`, document.baseURI));
    // Suspende este módulo até o navegador concluir o redirecionamento.
    await new Promise(() => {});
} else {
    try {
        await carregarModulosDePagina();
    } catch (error) {
        const loader = document.getElementById('page-module-loader');
        if (loader) {
            loader.classList.add('page-module-loader-error');
            loader.textContent = `${error.message} Execute o projeto por um servidor local.`;
        }
        console.error(error);
        throw error;
    }
}

// Configuração única do Firebase.
const firebaseConfig = {
  apiKey: "AIzaSyCimjUFC1INckF4Potv8aDfrZ0gcmks6XE",
  authDomain: "checklog-abb92.firebaseapp.com",
  databaseURL: "https://checklog-abb92-default-rtdb.firebaseio.com",
  projectId: "checklog-abb92",
  storageBucket: "checklog-abb92.firebasestorage.app",
  messagingSenderId: "733177327355",
  appId: "1:733177327355:web:3b29319005247a7de40a5e",
  measurementId: "G-VD1QKDP7FW"
};

const fireApp = initializeApp(firebaseConfig);
const auth    = getAuth(fireApp);
const db      = getDatabase(fireApp);

let deslocamentoServidorMs = 0;
let deslocamentoServidorAtualizadoEm = 0;

async function agoraServidorConfiavel(database = db) {
    const agoraLocal = Date.now();
    if (agoraLocal - deslocamentoServidorAtualizadoEm > 5 * 60_000) {
        const snapshot = await get(ref(database, '.info/serverTimeOffset'));
        const deslocamento = Number(snapshot.val());
        if (!Number.isFinite(deslocamento)) throw new Error('Não foi possível sincronizar o horário do servidor.');
        deslocamentoServidorMs = deslocamento;
        deslocamentoServidorAtualizadoEm = agoraLocal;
    }
    return new Date(Date.now() + deslocamentoServidorMs);
}

let secondaryApp = null;
let secondaryAuth = null;
let secondaryDb = null;

function obterFirebaseSecundario() {
    if (!secondaryApp) {
        secondaryApp = initializeApp(firebaseConfig, 'Secondary');
        secondaryAuth = getAuth(secondaryApp);
        secondaryDb = getDatabase(secondaryApp);
    }

    return { auth: secondaryAuth, db: secondaryDb };
}

// Controle de tema visual.
const KEY_TEMA = 'cl-theme';
const mediaTemaSistema = window.matchMedia('(prefers-color-scheme: dark)');

function temaResolvido(modo) {
    return modo === 'system'
        ? (mediaTemaSistema.matches ? 'dark' : 'light')
        : modo;
}

function atualizarBotoesTema(modo) {
    document.querySelectorAll('[data-theme-option]').forEach(btn => {
        const ativo = btn.dataset.themeOption === modo;
        btn.classList.toggle('active', ativo);
        btn.setAttribute('aria-pressed', String(ativo));
    });
}

function sincronizarTemaComPagina(pageId = document.querySelector('.page.active')?.id.replace('page-', '') || 'login') {
    const modo = localStorage.getItem(KEY_TEMA) || 'system';
    const temaVisivel = pageId === 'login' ? 'light' : temaResolvido(modo);
    document.documentElement.setAttribute('data-theme', temaVisivel);
    document.documentElement.setAttribute('data-theme-mode', modo);
    atualizarBotoesTema(modo);
}

function aplicarTema(tema) {
    const modo = tema || 'system';
    localStorage.setItem(KEY_TEMA, modo);
    sincronizarTemaComPagina();
}

sincronizarTemaComPagina('login');
mediaTemaSistema.addEventListener('change', () => {
    if ((localStorage.getItem(KEY_TEMA) || 'system') === 'system') sincronizarTemaComPagina();
});

const headerMenuToggle = document.getElementById('header-menu-toggle');
const headerMenu = document.getElementById('header-menu');
const headerScrim = document.getElementById('header-scrim');
const mobileHeaderMedia = window.matchMedia('(max-width: 900px)');

function sincronizarAcessibilidadeHeader(aberto, restaurarFoco = false) {
    const mobile = mobileHeaderMedia.matches;
    const conteudo = document.getElementById('app-content');
    const chatbot = document.querySelector('.chatbot-wrapper');
    if (!mobile) {
        document.body.classList.remove('header-menu-open');
        if (headerMenu) {
            headerMenu.inert = false;
            headerMenu.removeAttribute('aria-hidden');
        }
        if (headerScrim) headerScrim.hidden = true;
        headerMenuToggle?.setAttribute('aria-expanded', 'false');
        if (conteudo) conteudo.inert = false;
        if (chatbot) chatbot.inert = false;
        return;
    }

    if (headerMenu) {
        headerMenu.inert = !aberto;
        headerMenu.setAttribute('aria-hidden', String(!aberto));
    }
    if (headerScrim) headerScrim.hidden = !aberto;
    if (conteudo) conteudo.inert = aberto;
    if (chatbot) chatbot.inert = aberto;
    if (aberto) requestAnimationFrame(() => headerMenu?.querySelector('a[data-page]')?.focus());
    if (!aberto && restaurarFoco) headerMenuToggle?.focus();
}

function definirMenuHeaderAberto(aberto, restaurarFoco = false) {
    const abertoNoMobile = aberto && mobileHeaderMedia.matches;
    document.body.classList.toggle('header-menu-open', abertoNoMobile);
    headerMenuToggle?.setAttribute('aria-expanded', String(abertoNoMobile));
    headerMenuToggle?.setAttribute('aria-label', abertoNoMobile ? 'Fechar menu de módulos' : 'Abrir menu de módulos');
    sincronizarAcessibilidadeHeader(abertoNoMobile, restaurarFoco);
}

function sincronizarHeaderResponsivo() {
    definirMenuHeaderAberto(false);
}

headerMenuToggle?.addEventListener('click', () => {
    const abrir = !document.body.classList.contains('header-menu-open');
    definirMenuHeaderAberto(abrir, !abrir);
});
headerScrim?.addEventListener('click', () => definirMenuHeaderAberto(false, true));
sincronizarHeaderResponsivo();
mobileHeaderMedia.addEventListener('change', sincronizarHeaderResponsivo);

const settingsToggle = document.getElementById('settings-toggle');
const themeOverlay = document.getElementById('theme-overlay');
const themeClose = document.getElementById('theme-close');

function abrirTema() {
    if (!themeOverlay) return;
    fecharChatbot(false);
    themeOverlay.hidden = false;
    settingsToggle?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
        themeOverlay.classList.add('open');
        themeClose?.focus();
    });
}

function fecharTema(restaurarFoco = true) {
    if (!themeOverlay || themeOverlay.hidden) return;
    themeOverlay.classList.remove('open');
    settingsToggle?.setAttribute('aria-expanded', 'false');
    setTimeout(() => { themeOverlay.hidden = true; }, 180);
    if (restaurarFoco) settingsToggle?.focus();
}

if (settingsToggle) settingsToggle.addEventListener('click', abrirTema);
if (themeClose) themeClose.addEventListener('click', fecharTema);
if (themeOverlay) {
    themeOverlay.addEventListener('click', (event) => {
        if (event.target === themeOverlay) fecharTema();
    });
}
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        fecharTema();
        if (mobileHeaderMedia.matches && document.body.classList.contains('header-menu-open')) {
            definirMenuHeaderAberto(false, true);
        }
    }
});
document.querySelectorAll('[data-theme-option]').forEach(btn => {
    btn.addEventListener('click', () => aplicarTema(btn.dataset.themeOption));
});

// Roteamento da SPA.
const PAGINAS_AUTH  = ['login'];
const PAGINAS_ADMIN = ['cadastro', 'controle-estoque', 'gerenciamento-ponto', 'justificativas', 'dashboard', 'relatorios', 'encomendar', 'fornecedores'];

window.isAdmin  = false;
let authPronto  = false;   // Evita navegação antes da autenticação terminar.
let loginEmAndamento = false;
let revisaoAutenticacao = 0;
let usuarioAtual = null;
let funcionarioAtual = null;
let registrosPontoCache = [];
let funcionariosCache = [];
let historicoPontoCache = [];
let ultimoComprovantePonto = null;
let pontoEditandoKey = null;
let justificativasCache = [];
let minhasMovimentacoesCache = [];
let ultimoEmailBoasVindasPendente = null;
const justificativasEmRecuperacao = new Set();
let justificativasListenerAtivo = false;
let minhasMovimentacoesListenerAtivo = false;
let listenersAdministrativosAtivos = false;
let unsubscribeMeuPonto = null;
let unsubscribePontoAdmin = null;
let unsubscribeFuncionarios = null;
let unsubscribeHistoricoPonto = null;
let unsubscribeJustificativas = null;
let unsubscribeMinhasMovimentacoes = null;
let unsubscribeAvisos = null;
let unsubscribeEstoque = null;
let unsubscribeMovimentos = null;
let unsubscribeFornecedores = null;
let unsubscribeEncomendas = null;
let pedidosVisiveis = 12;
let relatoriosVisiveis = 50;
let decisionResolver = null;

function preferenceUid() {
    return auth.currentUser?.uid || usuarioAtual?.uid || 'anonymous';
}

function viewPreference(module) {
    return getViewPreference(localStorage, preferenceUid(), module);
}

function applyViewPreference(module, container) {
    const view = viewPreference(module);
    container?.classList.toggle('list-view', view === 'list');
    document.querySelectorAll(`[data-view-module="${module}"]`).forEach(button => {
        const active = button.dataset.view === view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    return view;
}

function setResultCount(id, total, singular, plural = singular + 's') {
    const element = document.getElementById(id);
    if (element) element.textContent = `${total} ${total === 1 ? singular : plural}`;
}

function showToast(message, tone = 'success', duration = 4200) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `app-toast toast-${tone}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.appendChild(criarElemento('span', '', message));
    const close = criarElemento('button', '', 'Fechar');
    close.type = 'button';
    close.addEventListener('click', () => toast.remove());
    toast.appendChild(close);
    region.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

const focoAnteriorPorDialogo = new WeakMap();

function exibirDialogo(dialogo, focoInicial = null) {
    if (!dialogo) return;
    fecharChatbot(false);
    if (document.activeElement instanceof HTMLElement) {
        focoAnteriorPorDialogo.set(dialogo, document.activeElement);
    }
    dialogo.hidden = false;
    dialogo.style.display = 'flex';
    requestAnimationFrame(() => {
        const alvo = typeof focoInicial === 'string' ? dialogo.querySelector(focoInicial) : focoInicial;
        (alvo || dialogo.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))?.focus();
    });
}

function ocultarDialogo(dialogo, restaurarFoco = true) {
    if (!dialogo) return;
    const estavaAberto = !dialogo.hidden && window.getComputedStyle(dialogo).display !== 'none';
    dialogo.hidden = true;
    dialogo.style.display = 'none';
    const retorno = focoAnteriorPorDialogo.get(dialogo);
    focoAnteriorPorDialogo.delete(dialogo);
    if (estavaAberto && restaurarFoco && retorno?.isConnected) retorno.focus();
}

function openDetailDrawer(title, rows = []) {
    const drawer = document.getElementById('detail-drawer');
    const scrim = document.getElementById('detail-drawer-scrim');
    const heading = document.getElementById('detail-drawer-title');
    const content = document.getElementById('detail-drawer-content');
    if (!drawer || !scrim || !heading || !content) return;
    fecharChatbot(false);
    if (document.activeElement instanceof HTMLElement) {
        focoAnteriorPorDialogo.set(drawer, document.activeElement);
    }
    heading.textContent = title;
    content.innerHTML = '';
    rows.filter(([, value]) => value !== undefined && value !== null && value !== '').forEach(([label, value]) => {
        const row = criarElemento('div', 'detail-row');
        row.append(criarElemento('span', '', label), criarElemento('strong', '', String(value)));
        content.appendChild(row);
    });
    drawer.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => drawer.classList.add('open'));
    document.getElementById('detail-drawer-close')?.focus();
}

function closeDetailDrawer() {
    const drawer = document.getElementById('detail-drawer');
    const scrim = document.getElementById('detail-drawer-scrim');
    const retorno = drawer ? focoAnteriorPorDialogo.get(drawer) : null;
    if (drawer) focoAnteriorPorDialogo.delete(drawer);
    drawer?.classList.remove('open');
    if (scrim) scrim.hidden = true;
    setTimeout(() => {
        if (drawer) drawer.hidden = true;
        if (retorno?.isConnected) retorno.focus();
    }, 180);
}

function requestDecision({ title, description, confirmText, fieldLabel = 'Observação', required = false, danger = false }) {
    const modal = document.getElementById('decision-modal');
    const form = document.getElementById('decision-form');
    const comment = document.getElementById('decision-comment');
    const error = document.getElementById('decision-error');
    if (!modal || !form || !comment || !error) return Promise.resolve(null);
    document.getElementById('decision-title').textContent = title;
    document.getElementById('decision-description').textContent = description || '';
    const label = document.querySelector('label[for="decision-comment"]');
    if (label) label.textContent = fieldLabel;
    const confirm = document.getElementById('decision-confirm');
    confirm.textContent = confirmText || 'Confirmar';
    confirm.classList.toggle('danger-action', danger);
    confirm.classList.toggle('btn', !danger);
    comment.value = '';
    comment.required = required;
    error.textContent = '';
    exibirDialogo(modal, comment);
    return new Promise(resolve => {
        decisionResolver = value => {
            decisionResolver = null;
            ocultarDialogo(modal);
            resolve(value);
        };
    });
}

function cancelDecision() {
    decisionResolver?.(null);
}

function applyColumnPreferences(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
    document.querySelectorAll(`[data-column-table="${tableId}"]`).forEach(toggle => {
        const index = Number(toggle.dataset.columnIndex);
        const stored = getPreference(localStorage, preferenceUid(), tableId, `column-${index}`, 'visible');
        const visible = stored !== 'hidden';
        toggle.checked = visible;
        table.querySelectorAll(`tr > *:nth-child(${index})`).forEach(cell => { cell.hidden = !visible; });
    });
}

function refreshViewModule(module) {
    if (module === 'fornecedores') renderFornecedores();
    if (module === 'justificativas') renderJustificativasAdmin();
    if (module === 'my-justifications') renderMeuCheckLog();
    if (module === 'encomendas') renderEncomendas();
}

document.querySelectorAll('[data-view-module]').forEach(button => {
    button.addEventListener('click', () => {
        setViewPreference(localStorage, preferenceUid(), button.dataset.viewModule, button.dataset.view);
        refreshViewModule(button.dataset.viewModule);
    });
});

document.querySelectorAll('[data-column-table]').forEach(toggle => {
    toggle.addEventListener('change', () => {
        setPreference(localStorage, preferenceUid(), toggle.dataset.columnTable, `column-${toggle.dataset.columnIndex}`, toggle.checked ? 'visible' : 'hidden');
        applyColumnPreferences(toggle.dataset.columnTable);
    });
});

document.querySelectorAll('[data-clear-toolbar]').forEach(button => {
    button.addEventListener('click', () => {
        const groups = {
            management: ['management-search', 'management-status-filter', 'management-sector-filter'],
            'admin-requests': ['request-search', 'request-status-filter', 'request-movement-filter', 'request-sort'],
            'my-requests': ['my-request-search', 'my-request-status', 'my-request-sort'],
            suppliers: ['supplier-search', 'supplier-status-filter', 'supplier-category-filter', 'supplier-sort'],
            orders: ['order-search', 'order-status-filter', 'order-priority-filter'],
            reports: ['report-search', 'report-type-filter', 'report-period-filter']
        };
        (groups[button.dataset.clearToolbar] || []).forEach(id => {
            const field = document.getElementById(id);
            if (!field) return;
            field.value = id.endsWith('-sort') ? (id === 'supplier-sort' ? 'name' : 'recent') : (id === 'report-period-filter' ? 'all' : '');
        });
        if (button.dataset.clearToolbar === 'management') renderPainelPonto();
        if (button.dataset.clearToolbar === 'admin-requests') renderJustificativasAdmin();
        if (button.dataset.clearToolbar === 'my-requests') renderMeuCheckLog();
        if (button.dataset.clearToolbar === 'suppliers') renderFornecedores();
        if (button.dataset.clearToolbar === 'orders') { pedidosVisiveis = 12; renderEncomendas(); }
        if (button.dataset.clearToolbar === 'reports') { relatoriosVisiveis = 50; renderRelatoriosEstoque(); }
    });
});

document.getElementById('decision-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const comment = document.getElementById('decision-comment');
    const error = document.getElementById('decision-error');
    if (comment.required && !comment.value.trim()) {
        error.textContent = 'Informe uma observação para continuar.';
        comment.focus();
        return;
    }
    decisionResolver?.(comment.value.trim());
});
document.getElementById('decision-close')?.addEventListener('click', cancelDecision);
document.getElementById('decision-cancel')?.addEventListener('click', cancelDecision);
document.getElementById('decision-modal')?.addEventListener('click', event => {
    if (event.target.id === 'decision-modal') cancelDecision();
});
document.getElementById('detail-drawer-close')?.addEventListener('click', closeDetailDrawer);
document.getElementById('detail-drawer-scrim')?.addEventListener('click', closeDetailDrawer);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        cancelDecision();
        closeDetailDrawer();
        fecharModalFornecedor();
        fecharFormularioProduto();
        fecharMovimentacaoEstoque();
        closeStockArViewer();
        fecharEditorPonto();
        fecharItensCriticos();
        fecharChatbot();
        return;
    }
    if (event.key !== 'Tab') return;
    const dialogos = [...document.querySelectorAll('[role="dialog"]')].filter(dialogo => {
        const estilo = window.getComputedStyle(dialogo);
        return !dialogo.closest('[hidden]') && !dialogo.closest('[inert]') && estilo.display !== 'none' && estilo.visibility !== 'hidden';
    });
    const dialogo = dialogos[dialogos.length - 1];
    if (!dialogo) return;
    const focaveis = [...dialogo.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(elemento => !elemento.disabled && window.getComputedStyle(elemento).display !== 'none');
    if (!focaveis.length) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (event.shiftKey && document.activeElement === primeiro) {
        event.preventDefault();
        ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
        event.preventDefault();
        primeiro.focus();
    }
});
function setAdminMenuVisible(isAdmin) {
    document.querySelectorAll('[data-admin-only="true"]').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });
}

function updateHomeForProfile(isAdmin) {
    const content = isAdmin ? {
        title: 'Acompanhe a operação diária do CheckLog.',
        description: 'Consulte jornada, solicitações, equipe e materiais críticos antes de iniciar as atividades do dia.',
        nextTitle: 'Fechamento diário',
        nextText: 'Validar pendências de ponto e itens com estoque baixo antes do encerramento do turno.',
        routine: ['Conferir entradas no início do turno.', 'Validar saídas para almoço e retornos pendentes.', 'Revisar itens abaixo do estoque mínimo.', 'Registrar encomendas antes do fechamento.']
    } : {
        title: 'Organize sua jornada em poucos passos.',
        description: 'Registre o ponto, acompanhe solicitações e consulte materiais vinculados ao seu usuário.',
        nextTitle: 'Conferir meu turno',
        nextText: 'Verifique o próximo movimento sugerido e possíveis pendências pessoais.',
        routine: ['Confirmar o próximo movimento do ponto.', 'Revisar registros realizados hoje.', 'Acompanhar respostas das solicitações de ajuste.', 'Conferir materiais vinculados ao seu usuário.']
    };
    const texts = {
        'home-profile-title': content.title,
        'home-profile-description': content.description,
        'home-profile-next-title': content.nextTitle,
        'home-profile-next-text': content.nextText
    };
    Object.entries(texts).forEach(([id, text]) => {
        const element = document.getElementById(id);
        if (element) element.textContent = text;
    });
    const list = document.getElementById('home-routine-list');
    if (list) {
        list.innerHTML = '';
        content.routine.forEach(text => list.appendChild(criarElemento('li', '', text)));
    }
    ['home-policy-card', 'home-responsibilities-card', 'home-module-responsibilities-card'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.hidden = !isAdmin;
    });
}

function encerrarListeners() {
    [
        unsubscribeMeuPonto, unsubscribePontoAdmin, unsubscribeFuncionarios, unsubscribeHistoricoPonto,
        unsubscribeJustificativas, unsubscribeMinhasMovimentacoes, unsubscribeAvisos,
        unsubscribeEstoque, unsubscribeMovimentos, unsubscribeFornecedores, unsubscribeEncomendas
    ].forEach(unsubscribe => {
        if (typeof unsubscribe === 'function') unsubscribe();
    });
    unsubscribeMeuPonto = unsubscribePontoAdmin = unsubscribeFuncionarios = unsubscribeHistoricoPonto = null;
    unsubscribeJustificativas = unsubscribeMinhasMovimentacoes = unsubscribeAvisos = null;
    unsubscribeEstoque = unsubscribeMovimentos = unsubscribeFornecedores = unsubscribeEncomendas = null;
    pontoListenerAtivo = false;
    meuPontoListenerAtivo = false;
    justificativasListenerAtivo = false;
    minhasMovimentacoesListenerAtivo = false;
    listenersAdministrativosAtivos = false;
}

function limparCachesSessao() {
    registrosPontoCache = [];
    funcionariosCache = [];
    historicoPontoCache = [];
    justificativasCache = [];
    minhasMovimentacoesCache = [];
    justificativasEmRecuperacao.clear();
    products = [];
    movimentosEstoque = [];
    fornecedores = [];
    encomendas = [];
    ultimoComprovantePonto = null;
    if (pieChart) {
        pieChart.destroy();
        pieChart = null;
    }
}

function rotaInicialAutenticada(hashAtual = window.location.hash.substring(1)) {
    const paginaExiste = document.getElementById('page-' + hashAtual);
    if (!hashAtual || hashAtual === 'login' || !paginaExiste) return window.isAdmin ? 'pagina-inicial' : 'meu-checklog';
    return hashAtual;
}

function piscarMetrica(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('metric-updated');
    void el.offsetWidth;
    el.classList.add('metric-updated');
}

function periodoSelecionado() {
    return document.getElementById('ponto-periodo')?.value || 'hoje';
}

function dataDentroPeriodo(registro, periodo = periodoSelecionado()) {
    if (!valorTimestampPonto(registro)) return false;
    const data = dataOperacionalISO(registro);
    if (!data) return false;
    const agora = new Date();
    if (periodo === 'hoje') return data === dataLocalISO(agora);
    if (periodo === 'mes-atual') {
        return data.startsWith(dataLocalISO(agora).slice(0, 7));
    }
    if (periodo === 'mes-anterior') {
        const anterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        return data.startsWith(dataLocalISO(anterior).slice(0, 7));
    }
    if (periodo === 'personalizado') {
        const inicioRaw = document.getElementById('ponto-data-inicio')?.value;
        const fimRaw = document.getElementById('ponto-data-fim')?.value;
        if (!inicioRaw || !fimRaw) return true;
        return data >= inicioRaw && data <= fimRaw;
    }
    return true;
}

function formatarDuracao(ms) {
    const sinal = ms < 0 ? '-' : '';
    const abs = Math.abs(ms);
    const h = Math.floor(abs / 3_600_000);
    const m = Math.floor((abs % 3_600_000) / 60_000);
    return sinal + h + 'h ' + String(m).padStart(2, '0') + 'min';
}

function normalizarMatricula(valor) {
    return String(valor || '').trim();
}

function somenteDigitos(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function cpfValido(valor) {
    const cpf = somenteDigitos(valor);
    if (!cpf) return true;
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    const digito = tamanho => {
        let soma = 0;
        for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (tamanho + 1 - i);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };
    return digito(9) === Number(cpf[9]) && digito(10) === Number(cpf[10]);
}

function mascararCPF(valor) {
    const cpf = somenteDigitos(valor);
    return cpf.length === 11 ? `***.***.***-${cpf.slice(-2)}` : '';
}

function copiaFirebase(valor) {
    return JSON.parse(JSON.stringify(valor ?? null));
}

function registrarHistoricoPonto(acao, anterior, atual = null, extra = {}) {
    const historicoRef = push(ref(db, 'historico_ponto'));
    return {
        key: historicoRef.key,
        path: `historico_ponto/${historicoRef.key}`,
        value: {
            acao,
            registroKey: anterior?.key || atual?.key || '',
            anterior: copiaFirebase(anterior),
            atual: copiaFirebase(atual),
            responsavelUid: auth.currentUser?.uid || '',
            responsavelEmail: auth.currentUser?.email || '',
            timestamp: new Date().toISOString(),
            ...extra
        }
    };
}

function registroPontoSemOperacao(registro = {}) {
    const limpo = { ...registro };
    delete limpo.operacaoPendente;
    return limpo;
}

function assinaturaRegistroPonto(registro = {}) {
    return JSON.stringify([
        registro.uid || '',
        String(registro.matricula || ''),
        registro.momento || '',
        Number(registro.timestampMs) || registro.timestamp || '',
        registro.ajustadoEm || '',
        registro.justificativaKey || ''
    ]);
}

async function reivindicarRegistroPonto(chave, esperado, tipo) {
    const token = push(ref(db, 'historico_ponto')).key;
    const iniciadoEm = await agoraServidorConfiavel();
    let motivo = 'O registro foi alterado por outro usuário. Atualize a página e tente novamente.';
    const resultado = await runTransaction(ref(db, `registros_ponto/${chave}`), atual => {
        if (!atual) {
            motivo = 'O registro não está mais disponível.';
            return;
        }
        const inicioPendente = Date.parse(atual.operacaoPendente?.iniciadoEm || '');
        const pendenteExpirada = Number.isFinite(inicioPendente) && iniciadoEm.getTime() - inicioPendente > 5 * 60_000;
        if (atual.operacaoPendente && !pendenteExpirada) {
            motivo = 'Este registro já está sendo alterado por outro usuário.';
            return;
        }
        if (assinaturaRegistroPonto(atual) !== assinaturaRegistroPonto(esperado)) return;
        return {
            ...atual,
            operacaoPendente: {
                token,
                tipo,
                iniciadoEm: iniciadoEm.toISOString(),
                responsavelUid: auth.currentUser?.uid || ''
            }
        };
    }, { applyLocally: false });
    if (!resultado.committed) throw new Error(motivo);
    return {
        token,
        registro: { key: chave, ...registroPontoSemOperacao(resultado.snapshot.val()) }
    };
}

function liberarRegistroPonto(chave, token) {
    if (!chave || !token) return Promise.resolve();
    return runTransaction(ref(db, `registros_ponto/${chave}`), atual => {
        if (!atual || atual.operacaoPendente?.token !== token) return;
        return registroPontoSemOperacao(atual);
    }, { applyLocally: false });
}

async function reservarDestinoRegistroPonto(chave, registro, token, origemKey) {
    const iniciadoEm = await agoraServidorConfiavel();
    const motivo = 'Já existe um registro desse movimento no dia selecionado.';
    const reservado = await runTransaction(ref(db, `registros_ponto/${chave}`), atual => {
        if (atual) {
            if (atual.operacaoPendente?.token === token) return atual;
            return;
        }
        return {
            ...registro,
            operacaoPendente: {
                token,
                tipo: 'reserva_destino',
                origemKey: origemKey || '',
                iniciadoEm: iniciadoEm.toISOString(),
                responsavelUid: auth.currentUser?.uid || ''
            }
        };
    }, { applyLocally: false });
    if (!reservado.committed) throw new Error(motivo);
}

function liberarReservaRegistroPonto(chave, token) {
    if (!chave || !token) return Promise.resolve();
    return runTransaction(ref(db, `registros_ponto/${chave}`), atual => {
        if (!atual || atual.operacaoPendente?.token !== token || atual.operacaoPendente?.tipo !== 'reserva_destino') return;
        return null;
    }, { applyLocally: false });
}

async function carregarRegistrosPontoAtuais() {
    const snapshot = await get(ref(db, 'registros_ponto'));
    return snapshotParaLista(snapshot, child => ({
        key: child.key,
        ...registroPontoSemOperacao(child.val())
    }));
}

function baixarTexto(nomeArquivo, conteudo) {
    const blob = new Blob([conteudo], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    a.click();
    URL.revokeObjectURL(url);
}

function baixarCSV(nomeArquivo, cabecalhos, linhas, opcoes = {}) {
    const conteudo = serializarCsv(cabecalhos, linhas, opcoes);
    const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    a.click();
    URL.revokeObjectURL(url);
}
window.navigate = function (pageId) {
    if (!auth.currentUser && pageId !== 'login') {
        pageId = 'login';
    }

    if (pageId === 'login' && auth.currentUser) {
        pageId = window.isAdmin ? 'pagina-inicial' : 'meu-checklog';
    }

    // Bloqueia páginas administrativas para usuários sem permissão.
    if (PAGINAS_ADMIN.includes(pageId) && !window.isAdmin) {
        showToast('Acesso negado: apenas usuários dos setores Administrativo, RH ou TI podem acessar este painel.', 'error', 6000);
        pageId = auth.currentUser ? 'meu-checklog' : 'login';
    }

    closeStockArViewer(false);

    // Ativa apenas a página solicitada.
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const alvo = document.getElementById('page-' + pageId);
    if (alvo) {
        alvo.classList.add('active');
    } else {
        const fallback = auth.currentUser
            ? (window.isAdmin ? 'pagina-inicial' : 'meu-checklog')
            : 'login';
        document.getElementById('page-' + fallback)?.classList.add('active');
        pageId = fallback;
    }

    // Cada tela pode ter uma altura diferente. Zera a rolagem antes das
    // renderizações para impedir que uma posição da tela anterior deixe o
    // começo ou o restante do novo módulo fora da área visível.
    const appContent = document.getElementById('app-content');
    if (appContent) appContent.scrollTop = 0;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    sincronizarTemaComPagina(pageId);

    // Ajusta navegação e rodapé conforme o estado da página.
    const eAuth = PAGINAS_AUTH.includes(pageId);
    const nav    = document.getElementById('global-nav');
    const footer = document.getElementById('global-footer');
    if (nav)    nav.style.display    = eAuth ? 'none' : 'flex';
    document.body.classList.toggle('has-sidebar', !eAuth);
    if (footer) footer.style.display = 'none';

    // Marca o item ativo no menu principal.
    const estoquePages = ['controle-estoque', 'dashboard', 'relatorios', 'encomendar'];
    document.querySelectorAll('#global-nav a[data-page]').forEach(a => {
        const isInventoryGroup = estoquePages.includes(pageId) && a.dataset.page === 'controle-estoque';
        const ativo = a.dataset.page === pageId || isInventoryGroup;
        a.classList.toggle('active', ativo);
        if (ativo) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });

    document.querySelectorAll('.inventory-tabs a[data-page]').forEach(a => {
        const ativo = a.dataset.page === pageId;
        a.classList.toggle('active', ativo);
        if (ativo) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });

    // Mantém as abas internas de estoque sincronizadas.
    document.querySelectorAll('.sidebar .nav a[data-page]').forEach(a => {
        const ativo = a.dataset.page === pageId;
        a.classList.toggle('active', ativo);
        if (ativo) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });

    // Mantém a rota refletida no hash da URL.
    if (window.location.hash !== '#' + pageId) {
        history.pushState(null, null, '#' + pageId);
    }

    // Atualiza os dados visíveis da página ativa.
    if (pageId === 'controle-estoque') renderEstoque(getListaEstoqueVisivel());
    if (pageId === 'dashboard') renderDashboardEstoque();
    if (pageId === 'relatorios') renderRelatoriosEstoque();
    if (pageId === 'fornecedores') renderFornecedores();
    if (pageId === 'encomendar') renderEncomendas();
    if (pageId === 'meu-checklog') renderMeuCheckLog();
    if (pageId === 'justificativas') renderJustificativasAdmin();
    if (pageId === 'registrar_ponto' && funcionarioAtual?.matricula) {
        const matricula = document.getElementById('matricula');
        if (matricula && !matricula.value) {
            matricula.value = funcionarioAtual.matricula;
            window.buscarFuncionario?.();
        }
    }
    atualizarChatbot(pageId);
    if (mobileHeaderMedia.matches) definirMenuHeaderAberto(false);
    appContent?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    requestAnimationFrame(() => {
        if (appContent) appContent.scrollTop = 0;
    });
    if (pageId !== 'login') {
        requestAnimationFrame(() => {
            const titulo = document.querySelector(`#page-${pageId} h1`);
            if (titulo) {
                titulo.tabIndex = -1;
                titulo.focus({ preventScroll: true });
            }
        });
    }
};

window.addEventListener('popstate', () => {
    if (!authPronto) return;
    const hash = window.location.hash.substring(1) || 'login';
    navigate(hash);
});

// Estado de autenticação e sessão.
onAuthStateChanged(auth, (user) => {
    const revisaoDestaResposta = ++revisaoAutenticacao;
    const sessaoAindaAtual = () => sessaoAutenticadaAtual(
        user,
        auth.currentUser,
        revisaoDestaResposta,
        revisaoAutenticacao
    );

    authPronto = true;
    document.body.classList.remove('auth-loading');

    const userProfile  = document.getElementById('user-profile');
    const loginArea    = document.getElementById('login-area');
    const emailDisplay = document.getElementById('user-email');
    const roleDisplay  = document.getElementById('user-role');

    if (user) {
        if (usuarioAtual?.uid && usuarioAtual.uid !== user.uid) {
            encerrarListeners();
            limparCachesSessao();
        }
        usuarioAtual = user;
        window.isAdmin = false;
        if (userProfile) userProfile.style.display = 'flex';
        if (loginArea)   loginArea.style.display   = 'none';

        // Define permissão administrativa pelo cargo ou setor.
        get(ref(db, 'cargos/' + user.uid)).then((snapshot) => {
            if (!sessaoAindaAtual()) return;
            window.isAdmin = false;
            let roleName   = 'COLABORADOR';

            if (snapshot.exists()) {
                const dados  = snapshot.val();
                const setor  = (dados.setor || '').trim();
                const permitidos = ['Administrativo', 'Recursos Humanos', 'TI'];
                window.isAdmin   = permitidos.includes(setor);
                roleName         = (dados.cargo || 'Colaborador').toUpperCase();
            }

            if (roleDisplay) roleDisplay.innerText = roleName;
            setAdminMenuVisible(window.isAdmin);
            updateHomeForProfile(window.isAdmin);
            const btnNovoAviso = document.getElementById('btn-novo-aviso');
            if (btnNovoAviso) btnNovoAviso.hidden = !window.isAdmin;
            if (window.isAdmin) {
                iniciarListenerPonto();
                iniciarListenersAdministrativos();
            } else {
                iniciarListenerMeuPonto();
            }
            iniciarListenerAvisos();
            iniciarListenerJustificativas();
            iniciarListenerMinhasMovimentacoes();

            if (window.isAdmin) {
                renderEstoque(getListaEstoqueVisivel());
                renderDashboardEstoque();
                renderRelatoriosEstoque();
            }

            const hash = window.location.hash.substring(1);
            navigate(rotaInicialAutenticada(hash));
            loginEmAndamento = false;
        }).catch((error) => {
            if (!sessaoAindaAtual()) return;
            console.error('Erro ao carregar permissões do usuário:', error);
            window.isAdmin = false;
            setAdminMenuVisible(false);
            updateHomeForProfile(false);
            if (roleDisplay) roleDisplay.innerText = 'COLABORADOR';
            const btnNovoAviso = document.getElementById('btn-novo-aviso');
            if (btnNovoAviso) btnNovoAviso.hidden = true;
            iniciarListenerMeuPonto();
            iniciarListenerAvisos();
            iniciarListenerJustificativas();
            iniciarListenerMinhasMovimentacoes();
            loginEmAndamento = false;
            navigate(rotaInicialAutenticada());
        });

        // Mostra o e-mail do usuário logado.
        const q = query(ref(db, 'funcionarios'), orderByChild('uid'), equalTo(user.uid));
        get(q).then((snap) => {
            if (!sessaoAindaAtual()) return;
            if (emailDisplay) {
                if (snap.exists()) {
                    const [matricula, dadosFunc] = Object.entries(snap.val())[0];
                    const func = { matricula, ...dadosFunc };
                    funcionarioAtual = func;
                    emailDisplay.innerText = func.email || user.email;
                    atualizarStatusTurno();
                    renderMeuCheckLog();
                } else {
                    funcionarioAtual = null;
                    emailDisplay.innerText = user.email;
                    atualizarStatusTurno();
                    renderMeuCheckLog();
                }
            }
        }).catch((error) => {
            if (!sessaoAindaAtual()) return;
            console.warn('Não foi possível carregar o cadastro do funcionário:', error.message);
            funcionarioAtual = null;
            if (emailDisplay) emailDisplay.innerText = user.email || '';
            atualizarStatusTurno();
            renderMeuCheckLog();
        });

    } else {
        encerrarListeners();
        limparCachesSessao();
        usuarioAtual = null;
        funcionarioAtual = null;
        window.isAdmin = false;
        setAdminMenuVisible(false);
        updateHomeForProfile(false);
        const btnNovoAviso = document.getElementById('btn-novo-aviso');
        if (btnNovoAviso) btnNovoAviso.hidden = true;
        if (userProfile) userProfile.style.display = 'none';
        if (loginArea)   loginArea.style.display   = 'flex';
        loginEmAndamento = false;
        const loginSubmit = document.querySelector('#loginForm button[type="submit"]');
        if (loginSubmit) loginSubmit.disabled = false;
        navigate('login');
    }
});

// Saída da sessão atual.
const btnSair = document.getElementById('btnSair');
if (btnSair) {
    btnSair.addEventListener('click', () => {
        signOut(auth)
            .then(() => navigate('login'))
            .catch(e => showToast('Erro ao sair: ' + e.message, 'error', 6000));
    });
}

// Mural de avisos sincronizado em tempo real.
const btnNovoAvisoGlobal = document.getElementById('btn-novo-aviso');
if (btnNovoAvisoGlobal) {
    btnNovoAvisoGlobal.addEventListener('click', async () => {
        if (!window.isAdmin) return;
        const titulo = await requestDecision({
            title: 'Novo aviso',
            description: 'Informe um título curto para o mural da empresa.',
            fieldLabel: 'Título do aviso',
            confirmText: 'Continuar',
            required: true
        });
        const tituloLimpo = titulo?.trim();
        if (!tituloLimpo) return;
        const mensagem = await requestDecision({
            title: 'Mensagem do aviso',
            description: `Título: ${tituloLimpo}`,
            fieldLabel: 'Mensagem',
            confirmText: 'Publicar aviso',
            required: true
        });
        const mensagemLimpa = mensagem?.trim();
        if (!mensagemLimpa) return;
        push(ref(db, 'avisos'), {
            titulo: tituloLimpo,
            mensagem: mensagemLimpa,
            autor: auth.currentUser?.email || '',
            timestamp: new Date().toISOString()
        })
            .then(() => showToast('Aviso publicado no mural.'))
            .catch(error => showToast('Erro ao publicar aviso: ' + error.message, 'error'));
    });
}

function iniciarListenerAvisos() {
    if (unsubscribeAvisos || !auth.currentUser) return;
    unsubscribeAvisos = onValue(ref(db, 'avisos'), (snapshot) => {
        const lista = document.getElementById('avisos-lista');
        if (!lista) return;
        const avisos = snapshotParaLista(snapshot, child => ({ key: child.key, ...child.val() }));
        avisos.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        lista.innerHTML = '';
        if (!avisos.length) {
            lista.appendChild(criarElemento('p', 'muted-note', 'Nenhum comunicado publicado.'));
            return;
        }
        avisos.slice(0, 5).forEach(aviso => {
            const item = criarElemento('div', 'notice-item');
            item.append(
                criarElemento('strong', '', aviso.titulo || 'Comunicado'),
                criarElemento('span', '', aviso.mensagem || aviso.texto || ''),
                criarElemento('small', '', aviso.timestamp ? new Date(aviso.timestamp).toLocaleString('pt-BR') : 'Publicado')
            );
            lista.appendChild(item);
        });
    }, error => console.warn('Não foi possível carregar avisos:', error.message));
}
// Fluxo de login.
const loginForm = document.getElementById('loginForm');

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (loginEmAndamento) return;
        const email    = document.getElementById('emailInput').value;
        const senha    = document.getElementById('passwordInput').value;
        const lembrar  = document.getElementById('lembrarInput').checked;
        const msg      = document.getElementById('mensagem');
        const persist  = lembrar ? browserLocalPersistence : browserSessionPersistence;
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        let autenticado = false;

        msg.style.color = '#0F766E';
        msg.innerText   = 'Autenticando...';
        loginEmAndamento = true;
        if (submitBtn) submitBtn.disabled = true;

        try {
            await setPersistence(auth, persist);
            await signInWithEmailAndPassword(auth, email, senha);
            autenticado = true;
            msg.style.color = '#15803D';
            msg.innerText = 'Login efetuado. Carregando seu acesso...';
        } catch (error) {
            msg.style.color = '#ef4444';
            const erros = {
                'auth/invalid-credential': 'E-mail ou senha incorretos.',
                'auth/invalid-login-credentials': 'E-mail ou senha incorretos.',
                'auth/user-not-found':     'E-mail ou senha incorretos.',
                'auth/wrong-password':     'E-mail ou senha incorretos.',
                'auth/network-request-failed': 'Não foi possível conectar. Verifique a internet e tente novamente.',
                'auth/too-many-requests': 'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.'
            };
            msg.innerText = erros[error.code] || 'Não foi possível entrar agora. Tente novamente.';
        } finally {
            if (!autenticado) {
                loginEmAndamento = false;
                if (submitBtn) submitBtn.disabled = false;
            }
        }
    });
}

// Cadastro de funcionários.
const cadastroForm = document.getElementById('cadastroForm');
const retryWelcomeEmail = document.getElementById('retry-welcome-email');

function atualizarRetryEmailBoasVindas() {
    if (retryWelcomeEmail) retryWelcomeEmail.hidden = !ultimoEmailBoasVindasPendente;
}

async function enviarEmailBoasVindas(payload) {
    if (!window.IntegratedEmail) throw new Error('Serviço de e-mail indisponível.');
    await window.IntegratedEmail.sendCheckLogWelcome(payload);
}

async function reenviarEmailBoasVindas() {
    if (!ultimoEmailBoasVindasPendente || !retryWelcomeEmail) return;
    const msg = document.getElementById('mensagemCad');
    retryWelcomeEmail.disabled = true;
    if (msg) {
        msg.style.color = '#FFD700';
        msg.innerText = 'Reenviando e-mail de boas-vindas...';
    }
    try {
        await enviarEmailBoasVindas(ultimoEmailBoasVindasPendente);
        ultimoEmailBoasVindasPendente = null;
        atualizarRetryEmailBoasVindas();
        if (msg) {
            msg.style.color = '#00FF7F';
            msg.innerText = 'E-mail de boas-vindas reenviado com sucesso.';
        }
    } catch (error) {
        if (msg) {
            msg.style.color = '#FF6347';
            msg.innerText = 'O reenvio falhou: ' + error.message;
        }
    } finally {
        retryWelcomeEmail.disabled = false;
    }
}

retryWelcomeEmail?.addEventListener('click', reenviarEmailBoasVindas);
document.getElementById('cpfInput')?.addEventListener('input', event => {
    const digitos = somenteDigitos(event.target.value).slice(0, 11);
    event.target.value = digitos
        .replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d)/, '.$1-$2');
});
if (cadastroForm) {
    cadastroForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitBtn = cadastroForm.querySelector('button[type="submit"]');
        if (submitBtn?.disabled) return;
        const email    = document.getElementById('emailInputCad').value;
        const senha    = document.getElementById('passwordInputCad').value;
        const nome     = document.getElementById('nomeInput').value;
        const matricula = normalizarMatricula(document.getElementById('matriculaInput').value);
        const cpf = document.getElementById('cpfInput')?.value || '';
        const cargo    = document.getElementById('cargoInput').value;
        const setor    = document.getElementById('setorInput').value;
        const turno    = document.getElementById('turnoInput').value;
        const msg      = document.getElementById('mensagemCad');
        let usuarioCriado = null;
        let cadastroPersistido = false;
        let authSecundaria = null;

        msg.style.color = '#FFD700';
        msg.innerText   = 'Processando cadastro...';

        if (!/^\d+$/.test(matricula)) {
            msg.style.color = '#FF6347';
            msg.innerText = 'Erro: A matrícula deve conter apenas números.';
            return;
        }
        if (!cpfValido(cpf)) {
            msg.style.color = '#FF6347';
            msg.innerText = 'Erro: Informe um CPF válido ou deixe o campo vazio.';
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
            const snapshot = await get(ref(db, 'funcionarios/' + matricula));
            if (snapshot.exists()) throw new Error('MATRICULA_EXISTS');

            authSecundaria = obterFirebaseSecundario().auth;
            await setPersistence(authSecundaria, inMemoryPersistence);
            const uc = await createUserWithEmailAndPassword(authSecundaria, email, senha);
            usuarioCriado = uc.user;
            const uid = uc.user.uid;
            await update(ref(db), {
                [`cargos/${uid}`]: { cargo, setor },
                [`funcionarios/${matricula}`]: {
                    uid, nome, email, cargo, setor, turno, cpfMascarado: mascararCPF(cpf)
                }
            });
            cadastroPersistido = true;
            await signOut(authSecundaria).catch(() => {});

            let emailEnviado = false;
            const emailBoasVindas = { email, name: nome, role: cargo };
            ultimoEmailBoasVindasPendente = emailBoasVindas;
            try {
                await enviarEmailBoasVindas(emailBoasVindas);
                emailEnviado = true;
                ultimoEmailBoasVindasPendente = null;
            } catch (emailError) {
                console.error('Funcionário cadastrado, mas o e-mail de boas-vindas falhou:', emailError);
                msg.style.color = '#FFB347';
                msg.innerText = `Funcionário cadastrado, mas o e-mail falhou: ${emailError.message}`;
            }
            atualizarRetryEmailBoasVindas();

            if (emailEnviado) {
                msg.style.color = '#00FF7F';
                msg.innerText = 'Funcionário cadastrado com sucesso. E-mail de boas-vindas enviado.';
            }
            cadastroForm.reset();
        } catch (error) {
            msg.style.color = '#FF6347';
            if (error.message === 'MATRICULA_EXISTS') {
                msg.innerText = 'Erro: esta matrícula já está em uso por outro funcionário.';
            } else {
                const erros = {
                    'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
                    'auth/weak-password':        'A senha deve ter pelo menos 6 caracteres.',
                    'PERMISSION_DENIED':          'Permissão negada. Confirme seu acesso administrativo e publique as regras atualizadas.',
                };
                msg.innerText = erros[error.code] || 'Erro: ' + error.message;
            }
            if (usuarioCriado && !cadastroPersistido) {
                await deleteUser(usuarioCriado).catch(() => {});
            }
            if (authSecundaria) await signOut(authSecundaria).catch(() => {});
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

// Registro de ponto.
window.buscarFuncionario = function () {
    const matricula = normalizarMatricula(document.getElementById('matricula')?.value);
    const msg       = document.getElementById('mensagemPonto');
    if (!msg) return;

    if (!matricula) {
        msg.style.color = 'red';
        msg.innerText   = 'Por favor, digite a matrícula.';
        return;
    }
    if (!/^\d+$/.test(matricula)) {
        msg.style.color = 'red';
        msg.innerText = 'A matrícula deve conter apenas números.';
        return;
    }
    msg.style.color = '#1A4A9E';
    msg.innerText   = 'Buscando dados...';

    get(ref(db, 'funcionarios/' + matricula)).then((snapshot) => {
        if (snapshot.exists()) {
            const dados = snapshot.val();
            document.getElementById('nome').value  = dados.nome  || '';
            document.getElementById('nome').dataset.email = dados.email || '';
            document.getElementById('nome').dataset.cpfMascarado = dados.cpfMascarado || '';
            document.getElementById('nome').dataset.turno = dados.turno || '';
            document.getElementById('setor').value = dados.setor || '';
            document.getElementById('cargo').value = dados.cargo || '';

            if (dados.turno) {
                const sel = document.getElementById('Iplanos');
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].text.includes(dados.turno)) {
                        sel.selectedIndex = i;
                        break;
                    }
                }
                sel.disabled = true;
            }
            msg.style.color = 'green';
            msg.innerText   = 'Dados encontrados! Selecione o movimento e confirme.';
        } else {
            msg.style.color = 'red';
            msg.innerText   = 'Matrícula não encontrada.';
            ['nome', 'setor', 'cargo'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('nome').dataset.email = '';
            document.getElementById('nome').dataset.cpfMascarado = '';
            document.getElementById('nome').dataset.turno = '';
        }
    }).catch(e => {
        msg.style.color = 'red';
        msg.innerText   = 'Erro ao buscar: ' + e.message;
    });
};

// Busca funcionário ao sair do campo matrícula.
const inputMatricula = document.getElementById('matricula');
if (inputMatricula) {
    inputMatricula.addEventListener('blur', window.buscarFuncionario);
}

const DURACAO_CONTROLE_PONTO_MS = 45_000;

function erroRegistroPonto(codigo, mensagem) {
    const erro = new Error(mensagem);
    erro.code = codigo;
    return erro;
}

async function adquirirControleRegistroPonto(
    databaseRef,
    uid,
    matricula,
    dataOperacional,
    movimento,
    pontoKey,
    instante
) {
    const controleRef = ref(databaseRef, `controles_ponto/${uid}/${dataOperacional}`);
    const token = push(ref(databaseRef, 'controles_ponto')).key;
    const adquiridoEm = instante.getTime();
    const resultado = await runTransaction(controleRef, atual => {
        const expirou = Number(atual?.expiraEm || 0) <= adquiridoEm;
        if (atual && !expirou) return;
        return {
            uid,
            matricula,
            dataOperacional,
            movimento,
            pontoKey,
            token,
            adquiridoEm,
            expiraEm: adquiridoEm + DURACAO_CONTROLE_PONTO_MS
        };
    }, { applyLocally: false });

    if (!resultado.committed) {
        throw erroRegistroPonto(
            'POINT_IN_PROGRESS',
            'Outro registro desta jornada está sendo processado. Aguarde alguns segundos e tente novamente.'
        );
    }
    return { ref: controleRef, token };
}

async function liberarControleRegistroPonto(controle) {
    if (!controle?.ref || !controle.token) return;
    await runTransaction(controle.ref, atual => {
        if (!atual || atual.token !== controle.token) return;
        return null;
    }, { applyLocally: false });
}

// Envio do formulário de ponto.
const formPonto = document.getElementById('formCadastro');
if (formPonto) {
    formPonto.addEventListener('submit', async function (e) {
        e.preventDefault();
        const nome      = document.getElementById('nome').value;
        const matricula = normalizarMatricula(document.getElementById('matricula').value);
        const setor     = document.getElementById('setor').value;
        const cargo     = document.getElementById('cargo').value;
        const msg       = document.getElementById('mensagemPonto');
        const submitBtn = formPonto.querySelector('button[type="submit"]');
        const reciboBtn = document.getElementById('btn-comprovante-ponto');
        const email     = document.getElementById('nome').dataset.email;
        const cpfMascarado = document.getElementById('nome').dataset.cpfMascarado || '';
        const senha     = document.getElementById('senha').value;

        if (submitBtn?.disabled) return;
        if (!nome || !cargo) {
            msg.style.color = 'red';
            msg.innerText   = 'Busque a matrícula antes de registrar.';
            return;
        }
        if (!email) {
            msg.style.color = 'red';
            msg.innerText   = 'E-mail não encontrado no cadastro. Contate o RH.';
            return;
        }

        const selPlanos  = document.getElementById('Iplanos');
        const selMomento = document.getElementById('Imomento');
        const turno      = document.getElementById('nome').dataset.turno || selPlanos.options[selPlanos.selectedIndex].text;
        const momento    = selMomento.options[selMomento.selectedIndex].value;
        let autenticouSecundario = false;
        let controlePonto = null;
        const { auth: authSecundaria, db: dbSecundario } = obterFirebaseSecundario();

        if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.originalText = submitBtn.textContent; submitBtn.textContent = 'Processando...'; }
        if (reciboBtn) reciboBtn.hidden = true;
        msg.style.color = '#1A4A9E';
        msg.innerText   = 'Autenticando...';

        try {
            await setPersistence(authSecundaria, inMemoryPersistence);
            await signInWithEmailAndPassword(authSecundaria, email, senha);
            autenticouSecundario = true;
            msg.innerText = 'Validando sequência...';

            const uid = authSecundaria.currentUser.uid;
            const instanteRegistro = await agoraServidorConfiavel(dbSecundario);
            const dataRegistro = dataOperacionalISO(instanteRegistro, turno);
            const pontoKey = chaveDeterministicaPonto(uid, dataRegistro, momento);
            controlePonto = await adquirirControleRegistroPonto(
                dbSecundario,
                uid,
                matricula,
                dataRegistro,
                momento,
                pontoKey,
                instanteRegistro
            );
            await validarRegistroPontoDoDia(
                matricula,
                momento,
                dbSecundario,
                uid,
                turno,
                instanteRegistro
            );
            const pontoRef = ref(dbSecundario, 'registros_ponto/' + pontoKey);
            const registro = {
                uid,
                nome,
                matricula,
                setor,
                cargo,
                cpfMascarado,
                tipo: turno,
                turno,
                momento,
                origem: 'maquina_ponto',
                dataOperacional: dataRegistro,
                controleToken: controlePonto.token,
                timestamp: instanteRegistro.toISOString(),
                timestampMs: serverTimestamp()
            };
            const gravacao = await runTransaction(pontoRef, atual => atual ? undefined : registro, { applyLocally: false });
            if (!gravacao.committed) {
                throw erroRegistroPonto('POINT_DUPLICATE', 'Este movimento já foi registrado nesta jornada.');
            }

            ultimoComprovantePonto = { key: pontoKey, ...registro, timestampMs: instanteRegistro.getTime() };
            msg.style.color = 'green';
            msg.innerText = `Ponto registrado com sucesso! (${momento})`;
            showToast(`Ponto registrado: ${momento}.`);
            if (reciboBtn) reciboBtn.hidden = false;
            setTimeout(() => formPonto.reset(), 3000);
        } catch (error) {
            msg.style.color = 'red';
            const erros = {
                'auth/invalid-credential': 'Senha incorreta ou conta não vinculada ao cadastro.',
                'auth/invalid-login-credentials': 'Senha incorreta ou conta não vinculada ao cadastro.',
                'auth/user-not-found': 'Conta do funcionário não encontrada. Contate o RH.',
                'auth/network-request-failed': 'Falha de conexão. Verifique a internet e tente novamente.',
                'POINT_IN_PROGRESS': 'Outro registro desta jornada está sendo processado. Aguarde alguns segundos e tente novamente.',
                'POINT_DUPLICATE': 'Este movimento já foi registrado nesta jornada.',
                'permission_denied': 'Este movimento já foi registrado hoje ou as regras publicadas estão desatualizadas.',
                'PERMISSION_DENIED': 'Este movimento já foi registrado hoje ou as regras publicadas estão desatualizadas.'
            };
            msg.innerText = erros[error.code] || erros[error.message] || (!error.code && error.message) || 'Não foi possível registrar o ponto.';
        } finally {
            const senhaInput = document.getElementById('senha');
            if (senhaInput) senhaInput.value = '';
            if (controlePonto) {
                await liberarControleRegistroPonto(controlePonto).catch(error => {
                    console.warn('Não foi possível liberar o controle temporário do ponto:', error.message);
                });
            }
            if (autenticouSecundario || authSecundaria.currentUser) await signOut(authSecundaria).catch(() => {});
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.originalText || 'Confirmar Registro'; }
        }
    });
}

// Gestão e auditoria de ponto.
let pontoListenerAtivo = false;
let meuPontoListenerAtivo = false;

function dataLocalISO(data = new Date()) {
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}

function valorTimestampPonto(registro = {}) {
    const timestampMs = Number(registro.timestampMs);
    if (Number.isFinite(timestampMs) && timestampMs > 0) return timestampMs;
    const legado = Date.parse(registro.timestamp || '');
    return Number.isFinite(legado) ? legado : 0;
}

function dataRegistroPonto(registro = {}) {
    return new Date(valorTimestampPonto(registro));
}

function compararPontoAsc(a, b) {
    return valorTimestampPonto(a) - valorTimestampPonto(b);
}

function movimentoNormalizado(registro = {}) {
    return (registro.momento || '').toString().trim().toLowerCase();
}

function registroAbreJornada(registro = {}) {
    return ['entrada', 'volta do almoço'].includes(movimentoNormalizado(registro));
}

function registroFechaJornada(registro = {}) {
    return ['saída para almoço', 'saida para almoço', 'saída', 'saida'].includes(movimentoNormalizado(registro));
}

function registroEncerraDia(registro = {}) {
    return ['saída', 'saida'].includes(movimentoNormalizado(registro));
}

function chaveFuncionarioDia(registro = {}) {
    const data = valorTimestampPonto(registro) ? dataOperacionalISO(registro) : 'sem-data';
    return `${registro.matricula || registro.uid || 'sem-matricula'}|${data}`;
}

function validarSequenciaMovimento(registrosDia, movimentoNovo) {
    const ordenados = registrosDia
        .filter(valorTimestampPonto)
        .sort(compararPontoAsc);
    const ultimo = ordenados[ordenados.length - 1];
    const novo = movimentoNovo.toLowerCase();

    if (!ultimo) {
        return novo === 'entrada'
            ? null
            : 'O primeiro movimento do dia precisa ser Entrada.';
    }

    const atual = movimentoNormalizado(ultimo);
    const permitidos = {
        'entrada': ['saída para almoço', 'saida para almoço', 'saída', 'saida'],
        'saída para almoço': ['volta do almoço'],
        'saida para almoço': ['volta do almoço'],
        'volta do almoço': ['saída', 'saida']
    };

    if (atual === 'saída' || atual === 'saida') {
        return 'Este colaborador já encerrou o turno hoje. Ajustes devem ser feitos no Painel de Gestão.';
    }

    return permitidos[atual]?.includes(novo)
        ? null
        : `Movimento inválido. Último registro: ${ultimo.momento || 'não identificado'}.`;
}

function validarSequenciaCompleta(registrosDia) {
    return validarSequenciaRegistros(registrosDia);
}

function validarRegistroPontoDoDia(
    matricula,
    movimentoNovo,
    databaseRef = db,
    uid = null,
    turno = '',
    instanteReferencia = new Date()
) {
    const qPonto = uid
        ? query(ref(databaseRef, 'registros_ponto'), orderByChild('uid'), equalTo(uid))
        : query(ref(databaseRef, 'registros_ponto'), orderByChild('matricula'), equalTo(matricula));
    return get(qPonto).then((snapshot) => {
        const hoje = dataOperacionalISO(instanteReferencia, turno);
        const registrosDia = [];
        snapshot.forEach(child => {
            const valor = { key: child.key, ...child.val() };
            if (
                valorTimestampPonto(valor) &&
                dataOperacionalISO(valor, turno) === hoje &&
                (!matricula || valor.matricula === matricula)
            ) {
                registrosDia.push(valor);
            }
        });
        const erro = validarSequenciaMovimento(registrosDia, movimentoNovo);
        if (erro) throw new Error(erro);
    });
}

function iniciarListenerMeuPonto() {
    if (meuPontoListenerAtivo || !auth.currentUser) return;
    meuPontoListenerAtivo = true;
    const qMeuPonto = query(ref(db, 'registros_ponto'), orderByChild('uid'), equalTo(auth.currentUser.uid));
    unsubscribeMeuPonto = onValue(qMeuPonto, (snapshot) => {
        registrosPontoCache = snapshotParaLista(snapshot, child => ({ ...child.val(), key: child.key }));
        registrosPontoCache.sort(compararPontoAsc);
        atualizarStatusTurno();
        renderMeuCheckLog();
        atualizarAlertasSistema();
    }, error => console.warn('Não foi possível carregar seus pontos:', error.message));
}
function iniciarListenerPonto() {
    if (pontoListenerAtivo) return;
    pontoListenerAtivo = true;

    unsubscribePontoAdmin = onValue(ref(db, 'registros_ponto'), (snapshot) => {
        registrosPontoCache = [];
        const dadosBrutos = snapshot.val() || {};
        Object.keys(dadosBrutos).forEach(k => registrosPontoCache.push({ ...dadosBrutos[k], key: k }));
        registrosPontoCache.sort(compararPontoAsc);
        renderPainelPonto();
        atualizarStatusTurno();
        renderMeuCheckLog();
        atualizarAlertasSistema();
    }, error => console.warn('Não foi possível carregar o painel de ponto:', error.message));

    unsubscribeFuncionarios = onValue(ref(db, 'funcionarios'), (snapshot) => {
        funcionariosCache = snapshotParaLista(snapshot, child => ({ matricula: child.key, ...child.val() }));
        renderPainelPonto();
        atualizarStatusTurno();
        atualizarSelectDestinatarios();
    }, error => console.warn('Não foi possível carregar funcionários:', error.message));

    unsubscribeHistoricoPonto = onValue(ref(db, 'historico_ponto'), snapshot => {
        historicoPontoCache = snapshotParaLista(snapshot, child => ({ key: child.key, ...child.val() }));
        historicoPontoCache.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        renderHistoricoPonto();
    }, error => console.warn('Não foi possível carregar o histórico de ponto:', error.message));
}

function recuperarJustificativasInterrompidas() {
    if (!window.isAdmin) return;
    const agora = Date.now();
    justificativasCache
        .filter(item => processamentoJustificativaExpirado(item, agora))
        .forEach(item => {
            if (justificativasEmRecuperacao.has(item.key)) return;
            justificativasEmRecuperacao.add(item.key);
            runTransaction(ref(db, `justificativas/${item.key}`), atual => {
                if (!processamentoJustificativaExpirado(atual, agora)) return;
                const restaurado = { ...atual, status: 'Pendente' };
                delete restaurado.respostaGestor;
                delete restaurado.decididoEm;
                delete restaurado.decididoPor;
                return restaurado;
            }, { applyLocally: false })
                .catch(error => console.warn('Não foi possível recuperar uma justificativa interrompida:', error.message))
                .finally(() => justificativasEmRecuperacao.delete(item.key));
        });
}

function iniciarListenerJustificativas() {
    if (justificativasListenerAtivo || !auth.currentUser) return;
    justificativasListenerAtivo = true;
    const origem = window.isAdmin
        ? ref(db, 'justificativas')
        : query(ref(db, 'justificativas'), orderByChild('uid'), equalTo(auth.currentUser.uid));
    unsubscribeJustificativas = onValue(origem, snapshot => {
        justificativasCache = snapshotParaLista(snapshot, child => ({ key: child.key, ...child.val() }));
        justificativasCache.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
        recuperarJustificativasInterrompidas();
        renderMeuCheckLog();
        renderJustificativasAdmin();
        atualizarAlertasSistema();
    }, error => console.warn('Não foi possível carregar justificativas:', error.message));
}

function iniciarListenerMinhasMovimentacoes() {
    if (minhasMovimentacoesListenerAtivo || !auth.currentUser) return;
    minhasMovimentacoesListenerAtivo = true;
    const origem = query(ref(db, 'movimentacoes_estoque'), orderByChild('destinatarioUid'), equalTo(auth.currentUser.uid));
    unsubscribeMinhasMovimentacoes = onValue(origem, snapshot => {
        minhasMovimentacoesCache = snapshotParaLista(snapshot, child => ({ key: child.key, ...child.val() }));
        minhasMovimentacoesCache.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        renderMeuCheckLog();
    }, error => console.warn('Não foi possível carregar movimentações pessoais:', error.message));
}

function meusRegistrosDoMes() {
    if (!usuarioAtual) return [];
    const mesAtual = dataLocalISO().slice(0, 7);
    return registrosPontoCache
        .filter(item => item.uid === usuarioAtual.uid || item.matricula === funcionarioAtual?.matricula)
        .filter(item => dataOperacionalISO(item).startsWith(mesAtual))
        .sort(compararPontoAsc);
}

function meusRegistrosVisiveis() {
    const periodo = document.getElementById('my-point-period')?.value || 'mes-atual';
    if (periodo === 'mes-atual') return meusRegistrosDoMes();
    const agora = new Date();
    const mesAnterior = dataLocalISO(new Date(agora.getFullYear(), agora.getMonth() - 1, 1)).slice(0, 7);
    return registrosPontoCache
        .filter(item => item.uid === usuarioAtual?.uid || item.matricula === funcionarioAtual?.matricula)
        .filter(item => {
            if (periodo === 'todos') return true;
            return dataOperacionalISO(item).startsWith(mesAnterior);
        })
        .sort(compararPontoAsc);
}

function minhasJustificativas() {
    return justificativasCache.filter(item => item.uid === usuarioAtual?.uid);
}

function definirRegistroOrigemJustificativa(registro = null) {
    const sourceKey = document.getElementById('just-source-key');
    const context = document.getElementById('just-source-context');
    if (sourceKey) sourceKey.value = registro?.key || '';
    if (context) context.hidden = !registro?.key;
}

function preencherSolicitacaoDoRegistro(item) {
    const date = document.getElementById('just-date');
    const movement = document.getElementById('just-movement');
    const time = document.getElementById('just-time');
    const reason = document.getElementById('just-reason');
    const data = dataRegistroPonto(item);
    definirRegistroOrigemJustificativa(item);
    if (date) date.value = dataLocalISO(data);
    if (movement) movement.value = item.momento || 'Entrada';
    if (time) time.value = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (reason) {
        reason.value = `Solicito correção do registro de ${item.momento || 'ponto'}.`;
        reason.focus();
        reason.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderMeuCheckLog() {
    const tbody = document.getElementById('my-points-body');
    if (!tbody) return;
    const registros = meusRegistrosDoMes();
    const registrosVisiveis = meusRegistrosVisiveis();
    const porDia = {};
    registros.forEach(item => {
        const chave = dataOperacionalISO(item);
        if (!porDia[chave]) porDia[chave] = [];
        porDia[chave].push(item);
    });
    const totalMs = Object.values(porDia).reduce((total, lista) => total + calcularTempoTrabalhado(lista), 0);
    const resumoBanco = Object.entries(porDia).map(([data, lista]) => {
        const ordenada = [...lista].sort(compararPontoAsc);
        return {
            data,
            encerrado: registroEncerraDia(ordenada[ordenada.length - 1]),
            trabalhadoMs: calcularTempoTrabalhado(lista)
        };
    });
    const bancoMs = saldoBancoHorasMs(resumoBanco);
    const pedidosPessoais = minhasJustificativas();
    const pendentes = pedidosPessoais.filter(item => item.status === 'Pendente').length;
    const valores = {
        'my-hours-month': formatarDuracao(totalMs),
        'my-hours-balance': formatarDuracao(bancoMs),
        'my-days-count': Object.keys(porDia).length,
        'my-pending-requests': pendentes
    };
    Object.entries(valores).forEach(([id, valor]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = valor;
    });
    document.getElementById('my-hours-balance')?.classList.toggle('negative-balance', bancoMs < 0);

    tbody.innerHTML = '';
    if (!registrosVisiveis.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;">Nenhum registro no período selecionado.</td></tr>';
    } else {
        let ultimoDia = '';
        registrosVisiveis.forEach(item => {
            const data = dataRegistroPonto(item);
            const dia = dataLocalISO(data);
            if (dia !== ultimoDia) {
                const grupo = document.createElement('tr');
                grupo.className = 'day-group-row';
                const cell = document.createElement('td');
                cell.colSpan = 5;
                cell.textContent = data.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
                grupo.appendChild(cell);
                tbody.appendChild(grupo);
                ultimoDia = dia;
            }
            const tr = document.createElement('tr');
            [data.toLocaleDateString('pt-BR'), item.momento || '-', item.turno || item.tipo || '-', data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })]
                .forEach(texto => tr.appendChild(criarElemento('td', '', texto)));
            const actionCell = document.createElement('td');
            const action = criarElemento('button', 'table-inline-action', 'Solicitar ajuste');
            action.type = 'button';
            action.addEventListener('click', () => preencherSolicitacaoDoRegistro(item));
            actionCell.appendChild(action);
            tr.appendChild(actionCell);
            tbody.appendChild(tr);
        });
    }

    const movimentos = document.getElementById('my-stock-movements');
    if (movimentos) {
        movimentos.innerHTML = '';
        const buscaMovimento = document.getElementById('my-movement-search')?.value || '';
        const movimentosFiltrados = minhasMovimentacoesCache.filter(item =>
            matchesSearch(item, buscaMovimento, ['name', 'tipo', 'observacao'])
        );
        if (!movimentosFiltrados.length) {
            movimentos.appendChild(criarElemento('p', 'muted-note', 'Nenhuma movimentação vinculada ao seu usuário.'));
        } else {
            movimentosFiltrados.slice(0, 8).forEach(item => {
                const card = criarElemento('div', 'personal-movement-item');
                card.append(
                    criarElemento('strong', '', item.name || 'Material'),
                    criarElemento('span', '', `${item.tipo || 'Movimentação'} · ${item.qty || 0} unidade(s)`),
                    criarElemento('small', '', item.timestamp ? new Date(item.timestamp).toLocaleString('pt-BR') : '')
                );
                movimentos.appendChild(card);
            });
        }
    }

    const pedidos = document.getElementById('my-justifications');
    if (pedidos) {
        pedidos.innerHTML = '';
        const buscaPedido = document.getElementById('my-request-search')?.value || '';
        const statusPedido = document.getElementById('my-request-status')?.value || '';
        const ordemPedido = document.getElementById('my-request-sort')?.value || 'recent';
        let pedidosFiltrados = pedidosPessoais.filter(item =>
            (!statusPedido || item.status === statusPedido) &&
            matchesSearch(item, buscaPedido, ['movimento', 'motivo', 'respostaGestor'])
        );
        pedidosFiltrados = sortItems(pedidosFiltrados, 'criadoEm', ordemPedido === 'oldest' ? 'asc' : 'desc', 'date');
        setResultCount('my-request-result-count', pedidosFiltrados.length, 'solicitação', 'solicitações');
        applyViewPreference('my-justifications', pedidos);
        if (!pedidosFiltrados.length) {
            const vazio = criarElemento('div', 'empty-state');
            vazio.append(criarElemento('strong', '', 'Nenhuma solicitação'), criarElemento('span', '', 'Seus pedidos de ajuste aparecerão aqui.'));
            pedidos.appendChild(vazio);
        } else {
            pedidosFiltrados.forEach(item => pedidos.appendChild(criarCardJustificativa(item, false)));
        }
    }
}

function criarCardJustificativa(item, modoAdmin) {
    const card = criarElemento('article', 'request-card');
    const header = criarElemento('div', 'supplier-card-header');
    const title = criarElemento('div');
    title.append(criarElemento('h3', '', modoAdmin ? (item.nome || item.email || 'Colaborador') : `${item.movimento} · ${item.data}`));
    if (modoAdmin) title.appendChild(criarElemento('p', 'muted-note', `${item.movimento || '-'} em ${item.data || '-'} às ${item.horario || '-'}`));
    const status = criarElemento('span', `request-status status-${(item.status || 'Pendente').toLowerCase()}`, item.status || 'Pendente');
    header.append(title, status);
    const motivo = criarElemento('p', 'request-reason', item.motivo || 'Sem justificativa informada.');
    const meta = criarElemento('div', 'purchase-order-meta');
    meta.append(
        criarElemento('span', '', item.criadoEm ? new Date(item.criadoEm).toLocaleString('pt-BR') : ''),
        criarElemento('span', '', item.respostaGestor || '')
    );
    card.append(header, motivo, meta);
    const actions = criarElemento('div', 'request-actions');
    if (item.anexo && /^https:\/\//i.test(item.anexo)) {
        const link = criarElemento('a', 'request-link', 'Abrir comprovante');
        link.href = item.anexo;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.appendChild(link);
    }
    if (modoAdmin && item.status === 'Pendente') {
        const approve = criarElemento('button', 'btn', 'Aprovar e aplicar');
        approve.type = 'button';
        approve.setAttribute('aria-label', `Aprovar solicitação de ${item.nome || item.email || 'colaborador'}`);
        approve.addEventListener('click', () => decidirJustificativa(item, true));
        const reject = criarElemento('button', 'secondary-action danger-inline', 'Recusar');
        reject.type = 'button';
        reject.setAttribute('aria-label', `Recusar solicitação de ${item.nome || item.email || 'colaborador'}`);
        reject.addEventListener('click', () => decidirJustificativa(item, false));
        actions.append(approve, reject);
    }
    const abrirDetalhes = event => {
        if (event?.target?.closest?.('button,a,select')) return;
        openDetailDrawer(modoAdmin ? (item.nome || item.email || 'Solicitação') : `${item.movimento || 'Ajuste'} · ${item.data || ''}`, [
            ['Status', item.status || 'Pendente'],
            ['Funcionário', item.nome || item.email],
            ['Matrícula', item.matricula],
            ['Setor', item.setor],
            ['Movimento', item.movimento],
            ['Data', item.data],
            ['Horário solicitado', item.horario],
            ['Motivo', item.motivo],
            ['Resposta da gestão', item.respostaGestor],
            ['Criado em', item.criadoEm ? new Date(item.criadoEm).toLocaleString('pt-BR') : '']
        ]);
    };
    card.addEventListener('click', abrirDetalhes);
    const detalhes = criarElemento('button', 'table-inline-action card-detail-action', 'Ver detalhes');
    detalhes.type = 'button';
    detalhes.setAttribute('aria-label', modoAdmin
        ? `Ver detalhes da solicitação de ${item.nome || item.email || 'colaborador'}`
        : `Ver detalhes da solicitação de ${item.data || 'ajuste'}`);
    detalhes.addEventListener('click', () => abrirDetalhes());
    actions.appendChild(detalhes);
    card.appendChild(actions);
    return card;
}

function renderJustificativasAdmin() {
    const lista = document.getElementById('admin-justifications');
    if (!lista || !window.isAdmin) return;
    const statusFiltro = document.getElementById('request-status-filter')?.value || '';
    const movimentoFiltro = document.getElementById('request-movement-filter')?.value || '';
    const busca = document.getElementById('request-search')?.value || '';
    const ordenacao = document.getElementById('request-sort')?.value || 'recent';
    const contagens = {
        Pendente: justificativasCache.filter(item => item.status === 'Pendente').length,
        Aprovado: justificativasCache.filter(item => item.status === 'Aprovado').length,
        Recusado: justificativasCache.filter(item => item.status === 'Recusado').length
    };
    [['request-pending-count', 'Pendente'], ['request-approved-count', 'Aprovado'], ['request-rejected-count', 'Recusado']].forEach(([id, chave]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = contagens[chave];
    });
    lista.innerHTML = '';
    let filtradas = justificativasCache.filter(item =>
        (!statusFiltro || item.status === statusFiltro) &&
        (!movimentoFiltro || item.movimento === movimentoFiltro) &&
        matchesSearch(item, busca, ['nome', 'email', 'matricula', 'motivo', 'setor'])
    );
    if (ordenacao === 'oldest') filtradas = sortItems(filtradas, 'criadoEm', 'asc', 'date');
    if (ordenacao === 'recent') filtradas = sortItems(filtradas, 'criadoEm', 'desc', 'date');
    if (ordenacao === 'name') filtradas = sortItems(filtradas, 'nome', 'asc');
    setResultCount('request-result-count', filtradas.length, 'solicitação', 'solicitações');
    applyViewPreference('justificativas', lista);
    if (!filtradas.length) {
        const vazio = criarElemento('div', 'empty-state');
        vazio.append(criarElemento('strong', '', 'Nenhuma solicitação neste filtro'), criarElemento('span', '', 'Altere o status selecionado para consultar outros pedidos.'));
        lista.appendChild(vazio);
        return;
    }
    filtradas.forEach(item => lista.appendChild(criarCardJustificativa(item, true)));
}

async function decidirJustificativa(item, aprovar) {
    if (!window.isAdmin || item.status !== 'Pendente') return;
    const resposta = await requestDecision({
        title: aprovar ? 'Aprovar e aplicar ajuste' : 'Recusar solicitação',
        description: `${item.nome || 'Colaborador'} · ${item.movimento || 'Movimento'} em ${item.data || '-'}`,
        confirmText: aprovar ? 'Aprovar ajuste' : 'Recusar solicitação',
        required: !aprovar,
        danger: !aprovar
    });
    if (resposta === null) return;
    const pedidoRef = ref(db, 'justificativas/' + item.key);
    const agora = (await agoraServidorConfiavel()).toISOString();
    let claimRegistro = null;
    let reservaRegistroKey = null;
    let operacaoToken = null;
    try {
        const claim = await runTransaction(pedidoRef, atual => {
            if (!atual || atual.status !== 'Pendente') return;
            return {
                ...atual,
                status: aprovar ? 'Processando' : 'Recusado',
                respostaGestor: resposta,
                decididoEm: agora,
                decididoPor: auth.currentUser?.email || ''
            };
        }, { applyLocally: false });
        if (!claim.committed) {
            showToast('Esta solicitação já foi analisada por outro usuário.', 'info', 6000);
            return;
        }
        let pedidoAtual = { key: item.key, ...claim.snapshot.val() };
        if (!aprovar) {
            showToast('Solicitação recusada e registrada.', 'info');
            return;
        }

        const funcionarioSnapshot = await get(ref(db, `funcionarios/${pedidoAtual.matricula}`));
        if (!funcionarioSnapshot.exists()) {
            throw new Error('O cadastro do funcionário não foi encontrado. Revise a solicitação antes de aprovar.');
        }
        const perfilOficial = funcionarioSnapshot.val();
        if (!perfilOficial.uid || perfilOficial.uid !== pedidoAtual.uid) {
            throw new Error('A solicitação não corresponde ao cadastro atual do funcionário.');
        }
        pedidoAtual = {
            ...pedidoAtual,
            nome: perfilOficial.nome || '',
            cargo: perfilOficial.cargo || '',
            setor: perfilOficial.setor || '',
            turno: perfilOficial.turno || ''
        };

        let registrosAtuais = await carregarRegistrosPontoAtuais();
        let registrosFuncionario = registrosAtuais.filter(registro =>
            (registro.uid === pedidoAtual.uid || registro.matricula === pedidoAtual.matricula) &&
            valorTimestampPonto(registro)
        );
        let registroOrigem = resolverRegistroOrigemNoHistorico(pedidoAtual, registrosFuncionario);
        if (pedidoAtual.registroOrigemKey && !registroOrigem) {
            throw new Error('O registro original foi alterado ou excluído. Atualize a solicitação antes de aprovar.');
        }
        if (!pedidoAtual.registroOrigemKey && registroOrigem) {
            pedidoAtual.registroOrigemKey = registroOrigem.key;
        }
        if (registroOrigem) {
            claimRegistro = await reivindicarRegistroPonto(registroOrigem.key, registroOrigem, 'justificativa');
            registroOrigem = claimRegistro.registro;
            registrosAtuais = await carregarRegistrosPontoAtuais();
            registrosFuncionario = registrosAtuais.filter(registro =>
                (registro.uid === pedidoAtual.uid || registro.matricula === pedidoAtual.matricula) &&
                valorTimestampPonto(registro)
            );
        }

        const aplicacao = prepararAplicacaoJustificativa({
            pedido: pedidoAtual,
            registroOrigem,
            registrosDoDia: registrosFuncionario,
            responsavelEmail: auth.currentUser?.email || '',
            decididoEm: agora
        });
        const registroPersistido = { ...aplicacao.registro };
        delete registroPersistido.key;
        registroPersistido.dataOperacional = dataOperacionalISO(registroPersistido);
        const registroKey = chaveDoRegistroPonto(registroPersistido);
        if (!registroKey) throw new Error('Não foi possível gerar uma chave segura para o ajuste.');
        operacaoToken = claimRegistro?.token || push(ref(db, 'historico_ponto')).key;
        if (registroKey !== aplicacao.registroKey) {
            await reservarDestinoRegistroPonto(registroKey, registroPersistido, operacaoToken, aplicacao.registroKey);
            reservaRegistroKey = registroKey;
        }
        const historico = registrarHistoricoPonto(
            aplicacao.tipo === 'edicao' ? 'AJUSTE_APROVADO' : 'ABONO_APROVADO',
            aplicacao.anterior,
            { key: registroKey, ...registroPersistido },
            { justificativaKey: pedidoAtual.key }
        );
        const atualizacoes = {
            [`registros_ponto/${registroKey}`]: copiaFirebase(registroPersistido),
            [`justificativas/${item.key}/status`]: 'Aprovado',
            [`justificativas/${item.key}/registroAplicadoKey`]: registroKey,
            [`justificativas/${item.key}/tipoAplicacao`]: aplicacao.tipo,
            [historico.path]: historico.value
        };
        if (aplicacao.tipo === 'edicao') {
            if (aplicacao.registroKey && aplicacao.registroKey !== registroKey) {
                atualizacoes[`registros_ponto/${aplicacao.registroKey}`] = null;
            }
            atualizacoes[`justificativas/${item.key}/registroAtualizadoKey`] = registroKey;
        } else {
            atualizacoes[`justificativas/${item.key}/registroCriadoKey`] = registroKey;
        }
        await update(ref(db), atualizacoes);
        showToast('Ajuste aprovado e aplicado ao registro de ponto.');
    } catch (error) {
        await liberarReservaRegistroPonto(reservaRegistroKey, operacaoToken).catch(() => {});
        await liberarRegistroPonto(claimRegistro?.registro?.key, claimRegistro?.token).catch(() => {});
        if (aprovar) {
            await runTransaction(pedidoRef, atual => {
                if (!atual || atual.status !== 'Processando' || atual.decididoEm !== agora) return;
                const restaurado = { ...atual, status: 'Pendente' };
                delete restaurado.respostaGestor;
                delete restaurado.decididoEm;
                delete restaurado.decididoPor;
                return restaurado;
            }, { applyLocally: false }).catch(() => {});
        }
        showToast('Erro ao analisar justificativa: ' + error.message, 'error', 6500);
    }
}

document.getElementById('just-date')?.setAttribute('max', dataLocalISO());
document.getElementById('clear-just-source')?.addEventListener('click', () => {
    definirRegistroOrigemJustificativa();
    const reason = document.getElementById('just-reason');
    if (reason?.value.startsWith('Solicito correção do registro de ')) reason.value = '';
});
document.getElementById('justification-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const submitBtn = event.target.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    if (!usuarioAtual || !funcionarioAtual) {
        showToast('Seu cadastro de funcionário ainda não foi vinculado. Contate o RH.', 'error', 6000);
        return;
    }
    const pedido = {
        uid: usuarioAtual.uid,
        email: funcionarioAtual.email || usuarioAtual.email || '',
        nome: funcionarioAtual.nome || '',
        matricula: funcionarioAtual.matricula || '',
        setor: funcionarioAtual.setor || '',
        cargo: funcionarioAtual.cargo || '',
        turno: funcionarioAtual.turno || '',
        data: document.getElementById('just-date').value,
        movimento: document.getElementById('just-movement').value,
        horario: document.getElementById('just-time').value,
        motivo: document.getElementById('just-reason').value.trim(),
        anexo: document.getElementById('just-attachment').value.trim(),
        registroOrigemKey: document.getElementById('just-source-key')?.value || '',
        status: 'Pendente',
        criadoEm: new Date().toISOString()
    };
    if (!pedido.data || !pedido.horario || !pedido.motivo) return;
    if (pedido.data > dataLocalISO()) {
        showToast('Não é possível solicitar ajuste para uma data futura.', 'error', 6000);
        return;
    }
    if (pedido.anexo && !/^https:\/\//i.test(pedido.anexo)) {
        showToast('Use um link seguro iniciado por https:// para o comprovante.', 'error', 6000);
        return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
        await push(ref(db, 'justificativas'), pedido);
        event.target.reset();
        definirRegistroOrigemJustificativa();
        const msg = document.getElementById('justification-message');
        if (msg) msg.textContent = 'Solicitação enviada para análise.';
        showToast('Solicitação enviada para análise.');
    } catch (error) {
        showToast('Erro ao enviar solicitação: ' + error.message, 'error', 6000);
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});

document.getElementById('request-status-filter')?.addEventListener('change', renderJustificativasAdmin);
document.getElementById('request-search')?.addEventListener('input', renderJustificativasAdmin);
document.getElementById('request-movement-filter')?.addEventListener('change', renderJustificativasAdmin);
document.getElementById('request-sort')?.addEventListener('change', renderJustificativasAdmin);
document.getElementById('my-request-search')?.addEventListener('input', renderMeuCheckLog);
document.getElementById('my-request-status')?.addEventListener('change', renderMeuCheckLog);
document.getElementById('my-request-sort')?.addEventListener('change', renderMeuCheckLog);
document.getElementById('my-movement-search')?.addEventListener('input', renderMeuCheckLog);
document.getElementById('my-point-period')?.addEventListener('change', renderMeuCheckLog);

function renderPainelPonto() {
    const tabelaCorpo  = document.getElementById('tabela-corpo');
    const lblServico   = document.getElementById('qtd-servico');
    const lblAtraso    = document.getElementById('qtd-atraso');
    const lblHoras     = document.getElementById('qtd-horas');
    const lblPendencia = document.getElementById('qtd-pendencia');
    const lblBanco     = document.getElementById('qtd-banco-horas');
    const tituloTabela = document.querySelector('#page-gerenciamento-ponto .data-panel .panel-heading-row h2');
    if (!tabelaCorpo) return;
    const periodoAtual = periodoSelecionado();
    const periodoEhHoje = periodoAtual === 'hoje';
    const labelsMetricas = {
        'qtd-servico-label': 'Ativos agora',
        'qtd-atraso-label': periodoEhHoje ? 'Hoje' : 'No período',
        'qtd-horas-label': periodoEhHoje ? 'Do dia' : 'No período',
        'qtd-pendencia-label': periodoEhHoje ? 'Sem saída' : 'Sem saída no período',
        'qtd-banco-label': periodoEhHoje ? 'Saldo do dia' : 'Saldo do período'
    };
    Object.entries(labelsMetricas).forEach(([id, texto]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = texto;
    });

    tabelaCorpo.innerHTML = '';
    if (tituloTabela) {
        const labelPeriodo = {
            'hoje': 'Registros de hoje',
            'mes-atual': 'Registros do mês atual',
            'mes-anterior': 'Registros do mês anterior',
            'personalizado': 'Registros do período personalizado'
        };
        tituloTabela.textContent = labelPeriodo[periodoSelecionado()] || 'Registros do período';
    }
    const registrosPeriodo = registrosPontoCache
        .filter(r => dataDentroPeriodo(r))
        .sort(compararPontoAsc);
    const setorInicial = document.getElementById('management-sector-filter');
    if (setorInicial) {
        const atual = setorInicial.value;
        const setores = [...new Set(funcionariosCache.map(item => item.setor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        setorInicial.innerHTML = '<option value="">Todos os setores</option>';
        setores.forEach(setor => setorInicial.appendChild(new Option(setor, setor)));
        setorInicial.value = setores.includes(atual) ? atual : '';
    }

    if (!registrosPeriodo.length) {
        tabelaCorpo.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94A3B8;padding:24px;">Nenhum registro no período selecionado.</td></tr>';
        [lblServico, lblAtraso, lblPendencia].forEach(el => { if (el) el.innerText = 0; });
        if (lblHoras) lblHoras.innerText = '0h';
        if (lblBanco) lblBanco.innerText = '0h';
        setResultCount('management-result-count', 0, 'registro');
        renderFuncionarioCards({});
        return;
    }

    const porFuncionario = {};
    const porFuncionarioDia = {};
    registrosPeriodo.forEach(r => {
        if (!porFuncionario[r.matricula]) porFuncionario[r.matricula] = [];
        porFuncionario[r.matricula].push(r);
        const chave = chaveFuncionarioDia(r);
        if (!porFuncionarioDia[chave]) porFuncionarioDia[chave] = [];
        porFuncionarioDia[chave].push(r);
    });

    let s = 0, a = 0, p = 0, totalMs = 0;
    const resumoBanco = [];
    const agora = new Date();
    const ultimosRegistrosDoDia = new Set();

    Object.values(porFuncionarioDia).forEach(listaDia => {
        listaDia.sort(compararPontoAsc);
        const ultimo = listaDia[listaDia.length - 1];
        ultimosRegistrosDoDia.add(ultimo.key);
        const dr     = dataRegistroPonto(ultimo);
        const diffMs = agora - dr;
        const diffHr = diffMs / 3_600_000;

        if (listaDia.some(registroEntradaAtrasada)) a++;

        const trabalhado = calcularTempoTrabalhado(listaDia, agora);
        totalMs += trabalhado;
        resumoBanco.push({
            data: dataOperacionalISO(ultimo),
            encerrado: registroEncerraDia(ultimo),
            trabalhadoMs: trabalhado
        });

        if (registroAbreJornada(ultimo)) {
            const ehHoje = dataOperacionalISO(ultimo) === dataOperacionalISO(agora, ultimo.turno || ultimo.tipo);
            if (diffHr > 12 || !ehHoje) p++;
            else s++;
        }
    });

    const busca = document.getElementById('management-search')?.value || '';
    const status = document.getElementById('management-status-filter')?.value || '';
    const setor = document.getElementById('management-sector-filter')?.value || '';
    const registrosFiltrados = registrosPeriodo.filter(registro => {
        if (!matchesSearch(registro, busca, ['nome', 'matricula', 'cargo', 'setor'])) return false;
        if (setor && registro.setor !== setor) return false;
        if (!status) return true;
        const data = dataRegistroPonto(registro);
        const diffHr = (agora - data) / 3_600_000;
        const ehUltimo = ultimosRegistrosDoDia.has(registro.key);
        const abre = registroAbreJornada(registro);
        const entradaAtrasada = registroEntradaAtrasada(registro);
        if (status === 'late') return entradaAtrasada;
        const ehHoje = dataOperacionalISO(registro) === dataOperacionalISO(agora, registro.turno || registro.tipo);
        if (status === 'active') return ehUltimo && abre && ehHoje && diffHr <= 12;
        if (status === 'pending') return ehUltimo && abre && (!ehHoje || diffHr > 12);
        if (status === 'closed') return ehUltimo && registroEncerraDia(registro);
        return true;
    });
    setResultCount('management-result-count', registrosFiltrados.length, 'registro');
    registrosFiltrados.forEach(registro => {
        const diffMs = agora - dataRegistroPonto(registro);
        criarLinhaTabela(registro, diffMs, movimentoNormalizado(registro), tabelaCorpo, ultimosRegistrosDoDia.has(registro.key));
    });
    if (!registrosFiltrados.length) {
        tabelaCorpo.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;">Nenhum registro corresponde aos filtros aplicados.</td></tr>';
    }

    const bancoMs = saldoBancoHorasMs(resumoBanco);
    if (lblServico)   lblServico.innerText   = s;
    if (lblAtraso)    lblAtraso.innerText     = a;
    if (lblPendencia) lblPendencia.innerText  = p;
    if (lblHoras)     lblHoras.innerText      = formatarDuracao(totalMs);
    if (lblBanco) {
        lblBanco.innerText = formatarDuracao(bancoMs);
        lblBanco.classList.toggle('negative-balance', bancoMs < 0);
    }
    renderFuncionarioCards(porFuncionario);
}

function renderHistoricoPonto() {
    const tbody = document.getElementById('ponto-audit-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!historicoPontoCache.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">Nenhum ajuste administrativo registrado.</td></tr>';
        return;
    }
    historicoPontoCache.slice(0, 50).forEach(item => {
        const tr = document.createElement('tr');
        const nome = item.atual?.nome || item.anterior?.nome || '-';
        const matricula = item.atual?.matricula || item.anterior?.matricula || '-';
        [
            item.acao || '-',
            `${nome} (${matricula})`,
            item.registroKey || `${item.quantidade || 0} registro(s)`,
            item.responsavelEmail || '-',
            item.timestamp ? new Date(item.timestamp).toLocaleString('pt-BR') : '-'
        ].forEach(valor => tr.appendChild(criarElemento('td', '', valor)));
        tbody.appendChild(tr);
    });
}

function calcularTempoTrabalhado(lista, agora = new Date()) {
    return calcularTempoTrabalhadoMs(lista, agora);
}

function validarRemocaoRegistroPonto(registro, registros = registrosPontoCache) {
    const data = dataOperacionalISO(registro);
    const restantes = registros.filter(item =>
        item.key !== registro.key &&
        ((registro.uid && item.uid === registro.uid) || item.matricula === registro.matricula) &&
        valorTimestampPonto(item) &&
        dataOperacionalISO(item) === data
    );
    return restantes.length ? validarSequenciaCompleta(restantes) : null;
}

function criarLinhaTabela(dados, diffMs, mov, tbody, ehUltimoRegistroDoDia = false) {
    const dr   = dataRegistroPonto(dados);
    const hora = dr.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const h    = Math.floor(diffMs / 3_600_000);
    const m    = Math.floor((diffMs % 3_600_000) / 60_000);
    const dHr  = diffMs / 3_600_000;

    let cls = 'status-fora';
    let txt = 'Registro';
    if (ehUltimoRegistroDoDia && registroAbreJornada(dados)) {
        cls = dHr > 12 ? 'status-fora' : 'status-trabalhando';
        txt = dHr > 12 ? 'Sem Saída'   : 'Em Serviço';
    } else if (ehUltimoRegistroDoDia) {
        txt = 'Turno Encerrado';
    }

    const tr = document.createElement('tr');
    
    const td1 = document.createElement('td');
    const str1 = document.createElement('strong');
    str1.textContent = dados.nome;
    const br1 = document.createElement('br');
    const sm1 = document.createElement('small');
    sm1.textContent = `${dados.cargo || ''} (${dados.matricula})`;
    td1.append(str1, br1, sm1);
    
    const td2 = document.createElement('td');
    const span2 = document.createElement('span');
    span2.className = cls;
    span2.textContent = txt;
    const br2 = document.createElement('br');
    const sm2 = document.createElement('small');
    sm2.textContent = dados.turno || dados.tipo || '';
    td2.append(span2, br2, sm2);
    
    const td3 = document.createElement('td');
    td3.textContent = `${dataOperacionalISO(dados)} • ${mov.toUpperCase()} às ${hora}`;
    
    const td4 = document.createElement('td');
    td4.textContent = ehUltimoRegistroDoDia && registroAbreJornada(dados) ? h + 'h ' + m + 'min' : '—';
    
    const td5 = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Editar';
    editBtn.className = 'inline-action';
    editBtn.addEventListener('click', () => abrirEditorPonto(dados));

    const btn = document.createElement('button');
    btn.textContent = 'Excluir';
    btn.className = 'inline-action danger-inline';
    btn.addEventListener('click', async () => {
        const confirmacao = await requestDecision({
            title: 'Excluir registro de ponto',
            description: `${dados.nome || 'Colaborador'} · ${dados.momento || 'Movimento'} em ${dataOperacionalISO(dados)}. A exclusão ficará na auditoria.`,
            confirmText: 'Excluir registro',
            danger: true
        });
        if (confirmacao === null) return;

        let claim = null;
        try {
            claim = await reivindicarRegistroPonto(dados.key, dados, 'exclusao');
            const registrosAtuais = await carregarRegistrosPontoAtuais();
            const erroSequencia = validarRemocaoRegistroPonto(claim.registro, registrosAtuais);
            if (erroSequencia) {
                throw new Error('A exclusão deixaria a sequência do dia inválida. Edite o registro ou use um abono: ' + erroSequencia);
            }
            const historico = registrarHistoricoPonto('EXCLUSAO', claim.registro);
            await update(ref(db), {
                [`registros_ponto/${dados.key}`]: null,
                [historico.path]: historico.value
            });
            showToast('Registro excluído com a auditoria preservada.', 'info');
        } catch (error) {
            await liberarRegistroPonto(dados.key, claim?.token).catch(() => {});
            showToast('Erro ao excluir registro: ' + error.message, 'error', 6500);
        }
    });
    td5.append(editBtn, btn);

    tr.append(td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
}

function renderFuncionarioCards(porFuncionario) {
    const box = document.getElementById('funcionarios-status-cards');
    if (!box) return;
    const base = funcionariosCache.length ? funcionariosCache : Object.values(porFuncionario).map(lista => lista[lista.length - 1]);
    if (!base.length) {
        box.innerHTML = '<p class="muted-note">Nenhum funcionário encontrado.</p>';
        return;
    }
    box.innerHTML = '';
    base.forEach(func => {
        const lista = porFuncionario[func.matricula] || [];
        const ultimo = lista[lista.length - 1];
        const dataUltimo = ultimo ? dataRegistroPonto(ultimo) : null;
        const aberto = ultimo ? registroAbreJornada(ultimo) : false;
        const ativo = aberto &&
            dataOperacionalISO(ultimo) === dataOperacionalISO(new Date(), ultimo.turno || ultimo.tipo) &&
            (Date.now() - dataUltimo.getTime()) <= 12 * 3_600_000;
        const resumo = !ultimo
            ? 'Sem registro no período'
            : aberto && !ativo
                ? `Sem saída • ${dataUltimo.toLocaleDateString('pt-BR')} ${dataUltimo.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                : `${ultimo.momento} • ${dataUltimo.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'employee-status-card ' + (ativo ? 'is-active' : 'is-off');
        card.append(
            criarElemento('strong', '', func.nome || 'Funcionário'),
            criarElemento('span', '', func.cargo || func.setor || 'Sem cargo'),
            criarElemento('small', '', resumo)
        );
        card.addEventListener('click', () => {
            const rows = [...document.querySelectorAll('#tabela-corpo tr')];
            const alvo = rows.find(r => r.textContent.includes(func.matricula || ''));
            if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        box.appendChild(card);
    });
}

function atualizarStatusTurno() {
    const card = document.getElementById('turno-status-card');
    const title = document.getElementById('turno-status-title');
    const text = document.getElementById('turno-status-text');
    if (!card || !title || !text || !usuarioAtual) return;
    const meus = registrosPontoCache
        .filter(r => r.uid === usuarioAtual.uid || r.matricula === funcionarioAtual?.matricula)
        .filter(r => valorTimestampPonto(r) && dataOperacionalISO(r) === dataOperacionalISO(new Date(), r.turno || r.tipo))
        .sort(compararPontoAsc);
    const ultimo = meus[meus.length - 1];
    card.classList.remove('not-started', 'in-shift', 'finished-shift');
    if (!ultimo) {
        card.classList.add('not-started');
        title.textContent = 'Você ainda não iniciou seu turno hoje';
        text.textContent = 'Registre a entrada para iniciar a jornada e evitar pendências no fechamento.';
        return;
    }
    const mov = (ultimo.momento || '').toLowerCase();
    const hora = dataRegistroPonto(ultimo).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (mov === 'entrada' || mov === 'volta do almoço') {
        card.classList.add('in-shift');
        title.textContent = 'Você está em turno';
        text.textContent = `Último movimento: ${ultimo.momento} às ${hora}. Tenha um bom trabalho.`;
    } else {
        card.classList.add('finished-shift');
        title.textContent = 'Turno encerrado ou em intervalo';
        text.textContent = `Último movimento: ${ultimo.momento} às ${hora}.`;
    }
}

function abrirEditorPonto(registro) {
    pontoEditandoKey = registro.key;
    const modal = document.getElementById('ponto-edit-modal');
    const momento = document.getElementById('edit-ponto-momento');
    const timestamp = document.getElementById('edit-ponto-timestamp');
    if (!modal || !momento || !timestamp) return;
    momento.value = registro.momento || 'Entrada';
    const dt = dataRegistroPonto(registro);
    const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    timestamp.value = local;
    exibirDialogo(modal, momento);
}

function validarAlteracaoRegistroPonto(original, atualizado, registros = registrosPontoCache) {
    const base = registros.filter(item => item.key !== original.key);
    const datas = new Set([original, atualizado].map(item => dataOperacionalISO(item)));
    for (const data of datas) {
        const lista = [...base, atualizado].filter(item =>
            ((original.uid && item.uid === original.uid) || item.matricula === original.matricula) &&
            valorTimestampPonto(item) &&
            dataOperacionalISO(item) === data
        );
        const erro = validarSequenciaCompleta(lista);
        if (erro) return erro;
    }
    return null;
}

function fecharEditorPonto() {
    const modal = document.getElementById('ponto-edit-modal');
    ocultarDialogo(modal);
    pontoEditandoKey = null;
}

async function salvarEdicaoPonto() {
    if (!pontoEditandoKey) return;
    const momento = document.getElementById('edit-ponto-momento')?.value;
    const timestampRaw = document.getElementById('edit-ponto-timestamp')?.value;
    if (!momento || !timestampRaw) return;
    const original = registrosPontoCache.find(item => item.key === pontoEditandoKey);
    if (!original) {
        showToast('O registro não está mais disponível. Atualize a página.', 'error', 6000);
        fecharEditorPonto();
        return;
    }
    let claim = null;
    let reservaKey = null;
    try {
        claim = await reivindicarRegistroPonto(pontoEditandoKey, original, 'edicao');
        const alteracoes = {
            momento,
            timestamp: new Date(timestampRaw).toISOString(),
            timestampMs: new Date(timestampRaw).getTime(),
            ajusteManual: true,
            ajustadoPor: auth.currentUser?.email || '',
            ajustadoEm: new Date().toISOString()
        };
        const atualizado = { ...claim.registro, ...alteracoes };
        const registrosAtuais = await carregarRegistrosPontoAtuais();
        const erroSequencia = validarAlteracaoRegistroPonto(claim.registro, atualizado, registrosAtuais);
        if (erroSequencia) throw new Error('A alteração deixaria a sequência de ponto inválida: ' + erroSequencia);

        const novoRegistroKey = chaveDoRegistroPonto(atualizado);
        if (!novoRegistroKey) throw new Error('Não foi possível gerar uma chave segura para o registro editado.');
        const atualizadoPersistido = { ...atualizado };
        delete atualizadoPersistido.key;
        atualizadoPersistido.dataOperacional = dataOperacionalISO(atualizadoPersistido);

        if (novoRegistroKey !== pontoEditandoKey) {
            await reservarDestinoRegistroPonto(novoRegistroKey, atualizadoPersistido, claim.token, pontoEditandoKey);
            reservaKey = novoRegistroKey;
        }
        const historico = registrarHistoricoPonto('EDICAO', claim.registro, { key: novoRegistroKey, ...atualizadoPersistido });
        const atualizacoes = {
            [`registros_ponto/${novoRegistroKey}`]: copiaFirebase(atualizadoPersistido),
            [historico.path]: historico.value
        };
        if (novoRegistroKey !== pontoEditandoKey) {
            atualizacoes[`registros_ponto/${pontoEditandoKey}`] = null;
        }
        await update(ref(db), atualizacoes);
        fecharEditorPonto();
    } catch (error) {
        await liberarReservaRegistroPonto(reservaKey, claim?.token).catch(() => {});
        await liberarRegistroPonto(pontoEditandoKey, claim?.token).catch(() => {});
        showToast('Erro ao salvar ajuste: ' + error.message, 'error', 6500);
    }
}

function imprimirEspelhoPonto() { window.print(); }

function exportarPontoCSV(registros = registrosPontoCache.filter(item => dataDentroPeriodo(item)), nome = 'espelho-ponto.csv') {
    baixarCSV(nome, ['Funcionário', 'Matrícula', 'Data', 'Horário', 'Movimento', 'Turno', 'Setor'], registros.map(item => {
        const data = dataRegistroPonto(item);
        return [
            item.nome || '',
            item.matricula || '',
            data.toLocaleDateString('pt-BR'),
            data.toLocaleTimeString('pt-BR'),
            item.momento || '',
            item.turno || item.tipo || '',
            item.setor || ''
        ];
    }));
}

async function baixarComprovantePonto() {
    if (!ultimoComprovantePonto) return;
    const r = ultimoComprovantePonto;
    const dadosAssinatura = [r.key, r.uid, r.matricula, r.momento, r.timestamp].join('|');
    const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dadosAssinatura));
    const hash = [...new Uint8Array(hashBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const linhas = [
        'CHECKLOG - COMPROVANTE DE PONTO',
        'Registro: ' + r.key,
        'Hash SHA-256: ' + hash,
        'Funcionário: ' + r.nome,
        'Matrícula: ' + r.matricula,
        'Setor: ' + r.setor,
        'Cargo: ' + r.cargo,
        'Movimento: ' + r.momento,
        'Turno: ' + r.tipo,
        'Data/Hora: ' + dataRegistroPonto(r).toLocaleString('pt-BR')
    ];
    if (r.cpfMascarado) linhas.splice(6, 0, 'CPF: ' + r.cpfMascarado);
    linhas.push('', 'A hash identifica o conteúdo deste comprovante e permite detectar alterações.');
    baixarTexto('comprovante-ponto-' + r.key + '.txt', linhas.join('\r\n'));
}
window.limparTudo = async function () {
    if (!window.isAdmin) return;
    const registrosVisiveis = registrosPontoCache.filter(item => dataDentroPeriodo(item));
    if (!registrosVisiveis.length) {
        showToast('Não há registros no período selecionado para apagar.', 'info');
        return;
    }
    const confirmacao = await requestDecision({
        title: 'Excluir registros do período',
        description: `${registrosVisiveis.length} registro(s) serão removidos e a ação ficará na auditoria. Digite EXCLUIR para confirmar.`,
        confirmText: 'Excluir período',
        fieldLabel: 'Confirmação',
        required: true,
        danger: true
    });
    if (confirmacao === null) return;
    if (confirmacao.trim().toUpperCase() !== 'EXCLUIR') {
        showToast('A confirmação não corresponde a EXCLUIR. Nenhum registro foi removido.', 'info');
        return;
    }

    const claims = [];
    try {
        const registrosPeriodo = (await carregarRegistrosPontoAtuais()).filter(item => dataDentroPeriodo(item));
        if (!registrosPeriodo.length) throw new Error('Os registros do período já foram removidos ou alterados.');
        for (const registro of registrosPeriodo) {
            claims.push(await reivindicarRegistroPonto(registro.key, registro, 'exclusao_em_lote'));
        }
        const exclusoes = {};
        claims.forEach(({ registro }) => {
            exclusoes[`registros_ponto/${registro.key}`] = null;
        });
        const historico = registrarHistoricoPonto('EXCLUSAO_EM_LOTE', null, null, {
            periodo: periodoSelecionado(),
            quantidade: claims.length,
            registroKeys: claims.map(item => item.registro.key)
        });
        exclusoes[historico.path] = historico.value;
        await update(ref(db), exclusoes);
        showToast(`${claims.length} registro(s) foram removidos com a auditoria preservada.`, 'info');
    } catch (error) {
        await Promise.allSettled(claims.map(item => liberarRegistroPonto(item.registro.key, item.token)));
        showToast('Erro ao apagar registros: ' + error.message, 'error', 6500);
    }
};

// Controle de estoque.
let products = [];
let movimentosEstoque = [];
let produtoEditandoKey = null;
let fornecedores = [];
let encomendas = [];
let fornecedorEditandoKey = null;
let visaoFinanceira = 'custo';
let produtoMovimentando = null;
let stockArProduct = null;
let stockArCameraController = null;
let stockArSession = 0;
const auditoriasEstoqueEmSincronizacao = new Set();
const recebimentosEncomendaEmRecuperacao = new Set();

function pedidoEmAberto(pedido) {
    return !['Recebido', 'Recusado', 'Cancelado'].includes(pedido.status);
}

function atualizarResumoOperacional() {
    const hoje = dataLocalISO(new Date());
    const movimentosHoje = movimentosEstoque.filter(item => item.timestamp && dataLocalISO(new Date(item.timestamp)) === hoje).length;
    const valores = {
        'home-critical-count': products.filter(p => Number(p.qty) <= Number(p.minQty || 0)).length,
        'home-supplier-count': fornecedores.filter(f => f.status === 'Ativo').length,
        'home-order-count': encomendas.filter(pedidoEmAberto).length,
        'home-activity-count': movimentosHoje
    };
    Object.entries(valores).forEach(([id, valor]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = valor;
    });
}

function atualizarAlertasSistema() {
    const lista = document.getElementById('home-alert-list');
    if (!lista) return;
    const alertas = [];
    const hoje = dataLocalISO();

    const meusHoje = registrosPontoCache
        .filter(item => item.uid === usuarioAtual?.uid || item.matricula === funcionarioAtual?.matricula)
        .filter(item => valorTimestampPonto(item) && dataOperacionalISO(item) === dataOperacionalISO(new Date(), item.turno || item.tipo))
        .sort(compararPontoAsc);
    const meuUltimo = meusHoje[meusHoje.length - 1];
    if (!meuUltimo) {
        alertas.push({ tom: 'warning', titulo: 'Ponto ainda não iniciado', texto: 'Registre sua entrada para evitar pendência.', pagina: 'registrar_ponto' });
    } else if (registroAbreJornada(meuUltimo)) {
        alertas.push({ tom: 'info', titulo: 'Jornada em andamento', texto: `Último movimento: ${meuUltimo.momento}.`, pagina: 'registrar_ponto' });
    }

    const minhasPendencias = justificativasCache.filter(item => item.status === 'Pendente').length;
    if (minhasPendencias) {
        alertas.push({
            tom: 'info',
            titulo: window.isAdmin ? `${minhasPendencias} justificativa(s) aguardando análise` : `${minhasPendencias} solicitação(ões) em análise`,
            texto: window.isAdmin ? 'Revise os pedidos enviados pela equipe.' : 'Acompanhe o retorno da gestão.',
            pagina: window.isAdmin ? 'justificativas' : 'meu-checklog'
        });
    }

    if (window.isAdmin) {
        const criticos = products.filter(item => Number(item.qty) <= Number(item.minQty || 0)).length;
        if (criticos) alertas.push({ tom: 'danger', titulo: `${criticos} item(ns) em estoque crítico`, texto: 'Revise os limites e inicie reposições.', pagina: 'controle-estoque' });
        const atrasados = encomendas.filter(item => pedidoEmAberto(item) && item.dataNecessaria && item.dataNecessaria < hoje).length;
        if (atrasados) alertas.push({ tom: 'danger', titulo: `${atrasados} compra(s) com prazo vencido`, texto: 'Atualize o status ou cobre o fornecedor.', pagina: 'encomendar' });
        const aguardando = encomendas.filter(item => item.status === 'Aguardando aprovação').length;
        if (aguardando) alertas.push({ tom: 'warning', titulo: `${aguardando} compra(s) aguardando aprovação`, texto: 'Analise os valores antes do envio.', pagina: 'encomendar' });
    }

    lista.innerHTML = '';
    if (!alertas.length) {
        const vazio = criarElemento('div', 'empty-state');
        vazio.append(criarElemento('strong', '', 'Tudo em ordem'), criarElemento('span', '', 'Nenhuma ação imediata foi identificada.'));
        lista.appendChild(vazio);
        return;
    }
    alertas.slice(0, 6).forEach(alerta => {
        const card = criarElemento('button', `alert-card alert-${alerta.tom}`);
        card.type = 'button';
        card.append(criarElemento('strong', '', alerta.titulo), criarElemento('span', '', alerta.texto));
        card.addEventListener('click', () => navigate(alerta.pagina));
        lista.appendChild(card);
    });
}

setInterval(atualizarAlertasSistema, 60_000);

function produtoNormalizado(p = {}) {
    return {
        name: (p.name || '').trim(),
        category: p.category || 'Outros',
        qty: Number.isFinite(Number(p.qty)) ? Number(p.qty) : 0,
        minQty: p.minQty === undefined ? 30 : (Number.isFinite(Number(p.minQty)) ? Number(p.minQty) : 30),
        price: Number.isFinite(Number(p.price)) ? Number(p.price) : 0,
        salePrice: Number.isFinite(Number(p.salePrice)) ? Number(p.salePrice) : Number(p.price || 0),
        auditPending: p.auditPending || null
    };
}

function getListaEstoqueVisivel() {
    const q = (document.getElementById('search')?.value || '').trim().toLowerCase();
    const categoria = document.getElementById('filter-category')?.value || '';
    return products.filter(p => {
        const correspondeBusca = !q ||
            (p.name || '').toLowerCase().includes(q) ||
            (p.category || '').toLowerCase().includes(q);
        return correspondeBusca && (!categoria || p.category === categoria);
    });
}

function metricasEstoque() {
    return {
        total: products.length,
        categorias: new Set(products.map(p => p.category).filter(Boolean)).size,
        baixo: products.filter(p => Number(p.qty) <= Number(p.minQty || 0)).length,
        quantidadeTotal: products.reduce((s, p) => s + Number(p.qty || 0), 0),
        valorTotal: products.reduce((s, p) => s + Number(p.qty || 0) * Number(p.price || 0), 0),
        faturamentoTotal: products.reduce((s, p) => s + Number(p.qty || 0) * Number(p.salePrice || 0), 0),
        margemTotal: products.reduce((s, p) => s + Number(p.qty || 0) * (Number(p.salePrice || 0) - Number(p.price || 0)), 0)
    };
}

function montarRegistroMovimentacaoEstoque(tipo, produto, extra = {}, movimentoKey = '') {
    return {
        movimentoKey,
        tipo,
        produtoKey: produto.key || null,
        name: produto.name || '',
        category: produto.category || '',
        qty: Number(produto.qty || 0),
        minQty: Number(produto.minQty || 0),
        price: Number(produto.price || 0),
        salePrice: Number(produto.salePrice || 0),
        timestamp: new Date().toISOString(),
        usuario: auth.currentUser?.email || '',
        operadorUid: auth.currentUser?.uid || '',
        operadorNome: funcionarioAtual?.nome || '',
        operadorMatricula: funcionarioAtual?.matricula || '',
        ...extra
    };
}

function persistirRegistroMovimentacaoEstoque(registro, movimentoKey, atualizacoesExtras = {}) {
    return update(ref(db), {
        [`movimentacoes_estoque/${movimentoKey}`]: registro,
        [`historico_estoque/${movimentoKey}`]: registro,
        ...atualizacoesExtras
    });
}

function registrarMovimentacaoEstoque(tipo, produto, extra = {}, movimentoKey = push(ref(db, 'movimentacoes_estoque')).key) {
    const registro = montarRegistroMovimentacaoEstoque(tipo, produto, extra, movimentoKey);
    return persistirRegistroMovimentacaoEstoque(registro, movimentoKey);
}

function atualizacoesExtrasDaAuditoria(pendente = {}) {
    const recebimento = pendente.pedidoRecebimento;
    if (!recebimento?.pedidoKey) return {};
    return {
        [`encomendas/${recebimento.pedidoKey}/status`]: 'Recebido',
        [`encomendas/${recebimento.pedidoKey}/statusAtualizadoEm`]: recebimento.timestamp,
        [`encomendas/${recebimento.pedidoKey}/statusAtualizadoPor`]: recebimento.responsavel,
        [`encomendas/${recebimento.pedidoKey}/recebidoEm`]: recebimento.timestamp,
        [`encomendas/${recebimento.pedidoKey}/recebidoPor`]: recebimento.responsavel,
        [`encomendas/${recebimento.pedidoKey}/movimentoRecebimentoKey`]: pendente.movimentoKey,
        [`encomendas/${recebimento.pedidoKey}/recebimentoClaim`]: null
    };
}

async function reconciliarAuditoriaPendente(produto) {
    const pendente = produto.auditPending;
    const movimentoKey = pendente?.movimentoKey;
    if (!movimentoKey || !pendente.registro || auditoriasEstoqueEmSincronizacao.has(movimentoKey)) return;
    auditoriasEstoqueEmSincronizacao.add(movimentoKey);
    try {
        await persistirRegistroMovimentacaoEstoque(pendente.registro, movimentoKey, atualizacoesExtrasDaAuditoria(pendente));
        await runTransaction(ref(db, 'estoque/' + produto.key), atual => {
            if (!atual || atual.auditPending?.movimentoKey !== movimentoKey) return;
            if (atual.auditPending?.excluirProduto) return null;
            const corrigido = { ...atual };
            delete corrigido.auditPending;
            return corrigido;
        }, { applyLocally: false });
    } catch (error) {
        console.warn('Não foi possível reconciliar auditoria pendente do estoque:', error.message);
    } finally {
        auditoriasEstoqueEmSincronizacao.delete(movimentoKey);
    }
}

function receberEstoque(snapshot) {
    products = [];
    snapshot.forEach((child) => {
        const p = produtoNormalizado(child.val());
        p.key = child.key;
        products.push(p);
    });
    products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    atualizarFiltroCategorias();
    atualizarSelectProdutosEncomenda();

    if (stockArProduct) {
        const atualizado = products.find(produto => produto.key === stockArProduct.key);
        if (atualizado) {
            stockArProduct = atualizado;
            renderStockArOverlay(atualizado);
        } else {
            closeStockArViewer();
            showToast('O produto aberto na visualização foi removido do estoque.', 'info');
        }
    }

    const ativa = document.querySelector('.page.active')?.id;
    if (ativa === 'page-controle-estoque') renderEstoque(getListaEstoqueVisivel());
    if (ativa === 'page-dashboard') renderDashboardEstoque();
    if (ativa === 'page-relatorios') renderRelatoriosEstoque();
    atualizarResumoOperacional();
    atualizarAlertasSistema();
    products.filter(produto => produto.auditPending).forEach(reconciliarAuditoriaPendente);
}

function receberMovimentacoes(snapshot) {
    movimentosEstoque = [];
    snapshot.forEach((child) => {
        movimentosEstoque.push({ key: child.key, ...child.val() });
    });
    movimentosEstoque.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    if (document.getElementById('page-relatorios')?.classList.contains('active')) {
        renderRelatoriosEstoque();
    }
    atualizarResumoOperacional();
    atualizarAlertasSistema();
}

function fornecedorNormalizado(item = {}) {
    const prazo = Number(item.leadTimeDays);
    const avaliacao = Number(item.rating);
    return {
        name: (item.name || '').trim(),
        cnpj: (item.cnpj || '').trim(),
        category: (item.category || '').trim(),
        contact: (item.contact || '').trim(),
        phone: (item.phone || '').trim(),
        email: (item.email || '').trim(),
        leadTimeDays: Number.isFinite(prazo) ? Math.max(0, prazo) : 0,
        rating: Number.isFinite(avaliacao) ? Math.min(5, Math.max(1, avaliacao)) : 5,
        status: item.status || 'Ativo',
        notes: (item.notes || '').trim(),
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || ''
    };
}

function fornecedorPorKey(key) {
    return fornecedores.find(item => item.key === key);
}

function metricasFornecedores() {
    const ativos = fornecedores.filter(item => item.status === 'Ativo');
    const prazoMedio = ativos.length
        ? Math.round(ativos.reduce((total, item) => total + Number(item.leadTimeDays || 0), 0) / ativos.length)
        : 0;
    return {
        total: fornecedores.length,
        ativos: ativos.length,
        prazoMedio,
        pedidosAbertos: encomendas.filter(pedidoEmAberto).length
    };
}

function atualizarFiltroCategoriasFornecedores() {
    const select = document.getElementById('supplier-category-filter');
    if (!select) return;
    const valorAtual = select.value;
    const categorias = [...new Set(fornecedores.map(item => item.category).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.innerHTML = '<option value="">Todas as categorias</option>';
    categorias.forEach(categoria => {
        const option = document.createElement('option');
        option.value = categoria;
        option.textContent = categoria;
        select.appendChild(option);
    });
    select.value = categorias.includes(valorAtual) ? valorAtual : '';
}

function atualizarSelectFornecedores() {
    const select = document.getElementById('enc-fornecedor');
    if (!select) return;
    const valorAtual = select.value;
    select.innerHTML = '<option value="">Selecione um fornecedor</option>';
    fornecedores
        .filter(item => item.status === 'Ativo')
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .forEach(item => {
            const option = document.createElement('option');
            option.value = item.key;
            option.textContent = `${item.name} · ${item.category || 'Sem categoria'}`;
            select.appendChild(option);
        });
    if ([...select.options].some(option => option.value === valorAtual)) select.value = valorAtual;
}

function fornecedoresFiltrados() {
    const busca = (document.getElementById('supplier-search')?.value || '').trim().toLowerCase();
    const status = document.getElementById('supplier-status-filter')?.value || '';
    const categoria = document.getElementById('supplier-category-filter')?.value || '';
    const ordenacao = document.getElementById('supplier-sort')?.value || 'name';
    let filtrados = fornecedores.filter(item => {
        const correspondeBusca = !busca || [item.name, item.category, item.contact, item.email, item.cnpj]
            .some(valor => (valor || '').toLowerCase().includes(busca));
        return correspondeBusca && (!status || item.status === status) && (!categoria || item.category === categoria);
    });
    if (ordenacao === 'rating') filtrados = sortItems(filtrados, 'rating', 'desc', 'number');
    if (ordenacao === 'lead') filtrados = sortItems(filtrados, 'leadTimeDays', 'asc', 'number');
    if (ordenacao === 'orders') {
        filtrados = [...filtrados].sort((a, b) =>
            encomendas.filter(item => item.fornecedorKey === b.key).length -
            encomendas.filter(item => item.fornecedorKey === a.key).length
        );
    }
    if (ordenacao === 'name') filtrados = sortItems(filtrados, 'name', 'asc');
    return filtrados;
}

function criarElemento(tag, classe, texto) {
    const elemento = document.createElement(tag);
    if (classe) elemento.className = classe;
    if (texto !== undefined) elemento.textContent = texto;
    return elemento;
}

function renderFornecedores() {
    const lista = document.getElementById('supplier-list');
    if (!lista) return;

    const metricas = metricasFornecedores();
    const textos = {
        'supplier-total': metricas.total,
        'supplier-active': metricas.ativos,
        'supplier-lead-time': metricas.prazoMedio + 'd',
        'supplier-open-orders': metricas.pedidosAbertos
    };
    Object.entries(textos).forEach(([id, valor]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = valor;
    });

    const filtrados = fornecedoresFiltrados();
    setResultCount('supplier-result-count', filtrados.length, 'fornecedor');
    applyViewPreference('fornecedores', lista);
    lista.innerHTML = '';
    if (!filtrados.length) {
        const vazio = criarElemento('div', 'empty-state');
        vazio.append(
            criarElemento('strong', '', fornecedores.length ? 'Nenhum fornecedor encontrado' : 'Cadastre o primeiro fornecedor'),
            criarElemento('span', '', fornecedores.length ? 'Ajuste os filtros para ampliar a busca.' : 'Organize contatos, prazos e compras em um só lugar.')
        );
        lista.appendChild(vazio);
        return;
    }

    filtrados.forEach(item => {
        const pedidosFornecedor = encomendas.filter(pedido => pedido.fornecedorKey === item.key);
        const card = criarElemento('article', 'supplier-card');
        const header = criarElemento('div', 'supplier-card-header');
        const titulo = criarElemento('div');
        titulo.append(criarElemento('h3', '', item.name), criarElemento('p', '', item.category || 'Sem categoria'));
        const status = criarElemento('span', `supplier-status ${item.status === 'Ativo' ? 'is-active' : ''}`, item.status);
        header.append(titulo, status);

        const contato = criarElemento('div', 'supplier-contact-list');
        contato.append(
            criarElemento('span', '', item.contact ? `Contato: ${item.contact}` : 'Contato não informado'),
            criarElemento('span', '', item.phone || 'Telefone não informado'),
            criarElemento('span', '', item.email || 'E-mail não informado'),
            criarElemento('span', '', item.cnpj || 'CNPJ não informado')
        );

        const meta = criarElemento('div', 'supplier-meta-row');
        meta.append(
            criarElemento('span', '', `Prazo: ${item.leadTimeDays || 0} dias`),
            criarElemento('span', 'supplier-rating', `Avaliação ${item.rating}/5`),
            criarElemento('span', '', `${pedidosFornecedor.length} pedido(s)`)
        );

        const footer = criarElemento('div', 'supplier-card-footer');
        const actions = criarElemento('div', 'supplier-card-actions');
        const novoPedido = criarElemento('button', 'supplier-primary-action', 'Novo pedido');
        novoPedido.type = 'button';
        novoPedido.setAttribute('aria-label', `Criar pedido para ${item.name || 'fornecedor'}`);
        novoPedido.addEventListener('click', () => {
            navigate('encomendar');
            const select = document.getElementById('enc-fornecedor');
            if (select) select.value = item.key;
        });
        const editar = criarElemento('button', '', 'Editar');
        editar.type = 'button';
        editar.setAttribute('aria-label', `Editar fornecedor ${item.name || 'sem nome'}`);
        editar.addEventListener('click', () => abrirModalFornecedor(item));
        const excluir = criarElemento('button', 'danger-inline', 'Excluir');
        excluir.type = 'button';
        excluir.setAttribute('aria-label', `Excluir fornecedor ${item.name || 'sem nome'}`);
        excluir.addEventListener('click', () => excluirFornecedor(item));
        footer.appendChild(actions);

        card.append(header, contato, meta, footer);
        const abrirDetalhes = event => {
            if (event?.target?.closest?.('button,a,select')) return;
            openDetailDrawer(item.name || 'Fornecedor', [
                ['Status', item.status],
                ['Categoria', item.category],
                ['CNPJ', item.cnpj],
                ['Contato', item.contact],
                ['Telefone', item.phone],
                ['E-mail', item.email],
                ['Prazo médio', `${item.leadTimeDays || 0} dias`],
                ['Avaliação', `${item.rating || 0}/5`],
                ['Pedidos associados', pedidosFornecedor.length],
                ['Observações', item.notes]
            ]);
        };
        card.addEventListener('click', abrirDetalhes);
        const detalhes = criarElemento('button', 'supplier-detail-action', 'Detalhes');
        detalhes.type = 'button';
        detalhes.setAttribute('aria-label', `Ver detalhes de ${item.name || 'fornecedor'}`);
        detalhes.addEventListener('click', () => abrirDetalhes());
        actions.append(novoPedido, detalhes, editar, excluir);
        lista.appendChild(card);
    });
}

function limparFormularioFornecedor() {
    fornecedorEditandoKey = null;
    document.getElementById('supplier-form')?.reset();
    const titulo = document.getElementById('supplier-modal-title');
    if (titulo) titulo.textContent = 'Cadastrar fornecedor';
    const status = document.getElementById('supplier-status');
    const rating = document.getElementById('supplier-rating');
    const lead = document.getElementById('supplier-lead');
    if (status) status.value = 'Ativo';
    if (rating) rating.value = '5';
    if (lead) lead.value = '0';
}

function abrirModalFornecedor(item = null) {
    const modal = document.getElementById('supplier-modal');
    if (!modal) return;
    limparFormularioFornecedor();
    if (item) {
        fornecedorEditandoKey = item.key;
        const campos = {
            'supplier-name': item.name,
            'supplier-cnpj': item.cnpj,
            'supplier-category': item.category,
            'supplier-contact': item.contact,
            'supplier-phone': item.phone,
            'supplier-email': item.email,
            'supplier-lead': item.leadTimeDays,
            'supplier-rating': item.rating,
            'supplier-status': item.status,
            'supplier-notes': item.notes
        };
        Object.entries(campos).forEach(([id, valor]) => {
            const campo = document.getElementById(id);
            if (campo) campo.value = valor ?? '';
        });
        const titulo = document.getElementById('supplier-modal-title');
        if (titulo) titulo.textContent = 'Editar fornecedor';
    }
    exibirDialogo(modal, '#supplier-name');
}

function fecharModalFornecedor() {
    const modal = document.getElementById('supplier-modal');
    ocultarDialogo(modal);
    limparFormularioFornecedor();
}

async function salvarFornecedor(event) {
    event.preventDefault();
    const submitBtn = event.target.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    const agora = new Date().toISOString();
    const item = fornecedorNormalizado({
        name: document.getElementById('supplier-name').value,
        cnpj: document.getElementById('supplier-cnpj').value,
        category: document.getElementById('supplier-category').value,
        contact: document.getElementById('supplier-contact').value,
        phone: document.getElementById('supplier-phone').value,
        email: document.getElementById('supplier-email').value,
        leadTimeDays: document.getElementById('supplier-lead').value,
        rating: document.getElementById('supplier-rating').value,
        status: document.getElementById('supplier-status').value,
        notes: document.getElementById('supplier-notes').value,
        updatedAt: agora
    });
    if (!item.name || !item.category) {
        showToast('Informe a empresa e a categoria principal.', 'error', 6000);
        return;
    }
    const cnpjNormalizado = somenteDigitos(item.cnpj);
    if (cnpjNormalizado && fornecedores.some(fornecedor =>
        fornecedor.key !== fornecedorEditandoKey && somenteDigitos(fornecedor.cnpj) === cnpjNormalizado
    )) {
        showToast('Já existe um fornecedor cadastrado com este CNPJ.', 'error', 6000);
        return;
    }

    const existente = fornecedorPorKey(fornecedorEditandoKey);
    item.createdAt = existente?.createdAt || agora;
    if (submitBtn) submitBtn.disabled = true;
    try {
        if (fornecedorEditandoKey) {
            await update(ref(db, 'fornecedores/' + fornecedorEditandoKey), item);
        } else {
            await set(push(ref(db, 'fornecedores')), item);
        }
        showToast(fornecedorEditandoKey ? 'Fornecedor atualizado.' : 'Fornecedor cadastrado.');
        fecharModalFornecedor();
    } catch (error) {
        showToast('Erro ao salvar fornecedor: ' + error.message, 'error', 6500);
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function excluirFornecedor(item) {
    const possuiPedidoAberto = encomendas.some(pedido => pedido.fornecedorKey === item.key && pedidoEmAberto(pedido));
    if (possuiPedidoAberto) {
        showToast('Este fornecedor possui compras em aberto. Marque-o como inativo depois de concluir ou cancelar os pedidos.', 'error', 7000);
        return;
    }
    const confirmacao = await requestDecision({
        title: 'Excluir fornecedor',
        description: `${item.name} · Esta ação não poderá ser desfeita.`,
        confirmText: 'Excluir fornecedor',
        danger: true
    });
    if (confirmacao === null) return;
    remove(ref(db, 'fornecedores/' + item.key))
        .then(() => showToast('Fornecedor excluído.', 'info'))
        .catch(error => showToast('Erro ao excluir fornecedor: ' + error.message, 'error', 6500));
}

function transicoesEncomenda(status) {
    const mapa = {
        'Solicitado': ['Solicitado', 'Em cotação', 'Cancelado'],
        'Aguardando aprovação': ['Aguardando aprovação'],
        'Em cotação': ['Em cotação', 'Aprovado', 'Cancelado'],
        'Aprovado': ['Aprovado', 'Pedido enviado', 'Cancelado'],
        'Pedido enviado': ['Pedido enviado', 'Recebido', 'Cancelado'],
        'Recebendo': ['Recebendo'],
        'Recebido': ['Recebido'],
        'Recusado': ['Recusado'],
        'Cancelado': ['Cancelado']
    };
    return mapa[status] || [status || 'Solicitado'];
}

async function receberEncomendaNoEstoque(pedido) {
    const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
    const agora = (await agoraServidorConfiavel()).toISOString();
    const pedidoRef = ref(db, `encomendas/${pedido.key}`);
    let pedidoAtual = null;
    let estoqueConfirmado = false;

    try {
        let motivoPedido = 'O pedido foi alterado por outro usuário. Atualize a lista e tente novamente.';
        const claim = await runTransaction(pedidoRef, atual => {
            if (!atual) {
                motivoPedido = 'O pedido não está mais disponível.';
                return;
            }
            if ((atual.status || 'Solicitado') !== 'Pedido enviado') {
                motivoPedido = 'Somente pedidos enviados podem ser recebidos no estoque.';
                return;
            }
            if (!atual.produtoKey) {
                motivoPedido = 'Este pedido antigo não está vinculado a um produto. Crie uma nova solicitação vinculada antes de registrar o recebimento.';
                return;
            }
            const quantidade = Number(atual.quantidade);
            if (!Number.isInteger(quantidade) || quantidade <= 0) {
                motivoPedido = 'A quantidade do pedido é inválida.';
                return;
            }
            return {
                ...atual,
                status: 'Recebendo',
                recebimentoClaim: {
                    token: movimentoKey,
                    iniciadoEm: agora,
                    iniciadoPor: auth.currentUser?.email || '',
                    iniciadoPorUid: auth.currentUser?.uid || ''
                }
            };
        }, { applyLocally: false });
        if (!claim.committed) throw new Error(motivoPedido);
        pedidoAtual = { key: pedido.key, ...claim.snapshot.val() };

        const quantidade = Number(pedidoAtual.quantidade);
        let motivoEstoque = 'O produto foi removido do estoque.';
        const resultado = await runTransaction(ref(db, `estoque/${pedidoAtual.produtoKey}`), atual => {
            if (!atual) return;
            if (atual.auditPending) {
                motivoEstoque = 'Existe uma movimentação pendente para este produto. Aguarde a sincronização e tente novamente.';
                return;
            }
            if (atual.recebimentos?.[pedidoAtual.key]) {
                motivoEstoque = 'Este pedido já foi incorporado ao estoque.';
                return;
            }
            const produtoAtual = produtoNormalizado(atual);
            const novoSaldo = produtoAtual.qty + quantidade;
            const registro = montarRegistroMovimentacaoEstoque('Recebimento de encomenda', {
                ...produtoAtual,
                key: pedidoAtual.produtoKey,
                qty: quantidade
            }, {
                pedidoKey: pedidoAtual.key,
                fornecedor: pedidoAtual.fornecedor || '',
                saldoAnterior: produtoAtual.qty,
                saldoAtual: novoSaldo,
                observacao: pedidoAtual.observacoes || ''
            }, movimentoKey);
            return {
                ...atual,
                qty: novoSaldo,
                recebimentos: { ...(atual.recebimentos || {}), [pedidoAtual.key]: agora },
                auditPending: {
                    movimentoKey,
                    registro,
                    pedidoRecebimento: {
                        pedidoKey: pedidoAtual.key,
                        claimToken: movimentoKey,
                        timestamp: agora,
                        responsavel: auth.currentUser?.email || ''
                    }
                }
            };
        }, { applyLocally: false });

        if (!resultado.committed) throw new Error(motivoEstoque);
        estoqueConfirmado = true;
        const pendente = resultado.snapshot.val()?.auditPending;
        await persistirRegistroMovimentacaoEstoque(pendente.registro, movimentoKey, atualizacoesExtrasDaAuditoria(pendente));
        await runTransaction(ref(db, `estoque/${pedidoAtual.produtoKey}`), atual => {
            if (!atual || atual.auditPending?.movimentoKey !== movimentoKey) return;
            const corrigido = { ...atual };
            delete corrigido.auditPending;
            return corrigido;
        }, { applyLocally: false });
    } catch (error) {
        if (pedidoAtual && !estoqueConfirmado) {
            await runTransaction(pedidoRef, atual => {
                if (!atual || atual.recebimentoClaim?.token !== movimentoKey) return;
                const restaurado = { ...atual, status: 'Pedido enviado' };
                delete restaurado.recebimentoClaim;
                return restaurado;
            }, { applyLocally: false }).catch(() => {});
        }
        if (!estoqueConfirmado) throw error;
        console.warn('Recebimento salvo com sincronização pendente:', error.message);
        showToast('O saldo foi atualizado e a conclusão do pedido será sincronizada automaticamente.', 'info', 6500);
    }
}

async function atualizarStatusEncomenda(pedido, novoStatus) {
    if (novoStatus === 'Recebido') {
        await receberEncomendaNoEstoque(pedido);
        return;
    }
    const pedidoRef = ref(db, 'encomendas/' + pedido.key);
    const resultado = await runTransaction(pedidoRef, atual => {
        if (!atual || !transicoesEncomenda(atual.status || 'Solicitado').includes(novoStatus)) return;
        return {
            ...atual,
            status: novoStatus,
            statusAtualizadoEm: new Date().toISOString(),
            statusAtualizadoPor: auth.currentUser?.email || ''
        };
    }, { applyLocally: false });
    if (!resultado.committed) throw new Error('Transição de status inválida ou pedido já atualizado.');
}

function renderEncomendas() {
    const lista = document.getElementById('pedidos-lista');
    if (!lista) return;
    const busca = document.getElementById('order-search')?.value || '';
    const statusFiltro = document.getElementById('order-status-filter')?.value || '';
    const prioridadeFiltro = document.getElementById('order-priority-filter')?.value || '';
    const filtradas = encomendas.filter(item =>
        (!statusFiltro || item.status === statusFiltro) &&
        (!prioridadeFiltro || item.prioridade === prioridadeFiltro) &&
        matchesSearch(item, busca, ['produto', 'fornecedor', 'responsavel', 'category'])
    );
    const pagina = paginate(filtradas, 1, pedidosVisiveis);
    const loadMore = document.getElementById('orders-load-more');
    if (loadMore) loadMore.hidden = pagina.items.length >= filtradas.length;
    setResultCount('order-result-count', filtradas.length, 'pedido');
    applyViewPreference('encomendas', lista);
    lista.innerHTML = '';
    if (!filtradas.length) {
        const vazio = criarElemento('div', 'empty-state');
        vazio.append(criarElemento('strong', '', encomendas.length ? 'Nenhum pedido encontrado' : 'Nenhuma solicitação registrada'), criarElemento('span', '', encomendas.length ? 'Ajuste os filtros para consultar outros pedidos.' : 'Crie uma compra para iniciar o acompanhamento.'));
        lista.appendChild(vazio);
        return;
    }

    pagina.items.forEach(pedido => {
        const card = criarElemento('article', 'purchase-order-card');
        const header = criarElemento('div', 'supplier-card-header');
        const titulo = criarElemento('div');
        titulo.append(criarElemento('h3', '', pedido.produto || 'Produto não informado'), criarElemento('p', 'muted-note', pedido.fornecedor || 'Fornecedor não informado'));
        const status = criarElemento('span', `order-status ${pedido.status === 'Recebido' ? 'is-done' : ''}`, pedido.status || 'Solicitado');
        header.append(titulo, status);

        const meta = criarElemento('div', 'purchase-order-meta');
        meta.append(
            criarElemento('span', '', `Qtd. ${pedido.quantidade || 1}`),
            criarElemento('span', 'priority-pill', pedido.prioridade || 'Normal'),
            criarElemento('span', '', pedido.valorEstimado ? formatBRL(pedido.valorEstimado) : 'Sem valor estimado'),
            criarElemento('span', '', pedido.dataNecessaria ? `Prazo: ${new Date(pedido.dataNecessaria + 'T12:00:00').toLocaleDateString('pt-BR')}` : ''),
            criarElemento('span', '', pedido.timestamp ? new Date(pedido.timestamp).toLocaleDateString('pt-BR') : '')
        );

        const select = document.createElement('select');
        select.setAttribute('aria-label', `Atualizar status do pedido de ${pedido.produto || 'produto'}`);
        transicoesEncomenda(pedido.status || 'Solicitado').forEach(nomeStatus => {
            const option = document.createElement('option');
            option.value = nomeStatus;
            option.textContent = nomeStatus;
            select.appendChild(option);
        });
        select.value = pedido.status || 'Solicitado';
        select.disabled = transicoesEncomenda(pedido.status || 'Solicitado').length === 1;
        select.addEventListener('change', async () => {
            const anterior = pedido.status || 'Solicitado';
            try {
                if (select.value === 'Recebido') {
                    const confirmacao = await requestDecision({
                        title: 'Receber pedido no estoque',
                        description: `${pedido.produto || 'Produto'} · ${pedido.quantidade || 1} unidade(s) serão somadas ao saldo atual.`,
                        confirmText: 'Confirmar recebimento'
                    });
                    if (confirmacao === null) {
                        select.value = anterior;
                        return;
                    }
                }
                select.disabled = true;
                await atualizarStatusEncomenda(pedido, select.value);
                showToast(`Pedido atualizado para "${select.value}".`);
            } catch (error) {
                select.value = anterior;
                showToast('Erro ao atualizar pedido: ' + error.message, 'error', 6500);
            } finally {
                select.disabled = transicoesEncomenda(pedido.status || 'Solicitado').length === 1;
            }
        });
        const footer = criarElemento('div', 'purchase-card-footer');
        card.append(header, meta);
        if (pedido.anexo && /^https:\/\//i.test(pedido.anexo)) {
            const link = criarElemento('a', 'request-link', 'Abrir cotação ou anexo');
            link.href = pedido.anexo;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            footer.appendChild(link);
        }
        if (pedido.status === 'Aguardando aprovação') {
            const actions = criarElemento('div', 'request-actions');
            const approve = criarElemento('button', 'btn', 'Aprovar compra');
            approve.type = 'button';
            approve.setAttribute('aria-label', `Aprovar compra de ${pedido.produto || 'produto'}`);
            approve.addEventListener('click', () => decidirEncomenda(pedido, true));
            const reject = criarElemento('button', 'secondary-action danger-inline', 'Recusar');
            reject.type = 'button';
            reject.setAttribute('aria-label', `Recusar compra de ${pedido.produto || 'produto'}`);
            reject.addEventListener('click', () => decidirEncomenda(pedido, false));
            actions.append(approve, reject);
            footer.appendChild(actions);
        }
        card.appendChild(select);
        const abrirDetalhes = event => {
            if (event?.target?.closest?.('button,a,select')) return;
            openDetailDrawer(pedido.produto || 'Pedido', [
                ['Status', pedido.status || 'Solicitado'],
                ['Fornecedor', pedido.fornecedor],
                ['Responsável', pedido.responsavel],
                ['Categoria', pedido.category],
                ['Quantidade', pedido.quantidade],
                ['Prioridade', pedido.prioridade],
                ['Valor estimado', pedido.valorEstimado ? formatBRL(pedido.valorEstimado) : 'Não informado'],
                ['Necessário até', pedido.dataNecessaria],
                ['Observações', pedido.observacoes],
                ['Decisão', pedido.decisaoComentario]
            ]);
        };
        card.addEventListener('click', abrirDetalhes);
        const detalhes = criarElemento('button', 'table-inline-action card-detail-action', 'Ver detalhes');
        detalhes.type = 'button';
        detalhes.setAttribute('aria-label', `Ver detalhes do pedido de ${pedido.produto || 'produto'}`);
        detalhes.addEventListener('click', () => abrirDetalhes());
        footer.appendChild(detalhes);
        card.appendChild(footer);
        lista.appendChild(card);
    });
}

async function decidirEncomenda(pedido, aprovar) {
    const comentario = await requestDecision({
        title: aprovar ? 'Aprovar compra' : 'Recusar compra',
        description: `${pedido.produto || 'Produto'} · ${pedido.fornecedor || 'Fornecedor não informado'}`,
        confirmText: aprovar ? 'Aprovar compra' : 'Recusar compra',
        required: !aprovar,
        danger: !aprovar
    });
    if (comentario === null) return;
    runTransaction(ref(db, 'encomendas/' + pedido.key), atual => {
        if (!atual || atual.status !== 'Aguardando aprovação') return;
        return {
            ...atual,
            status: aprovar ? 'Aprovado' : 'Recusado',
            decisaoComentario: comentario,
            decididoEm: new Date().toISOString(),
            decididoPor: auth.currentUser?.email || ''
        };
    }, { applyLocally: false }).then(resultado => {
        if (!resultado.committed) showToast('Este pedido já foi analisado por outro usuário.', 'info');
        else showToast(aprovar ? 'Compra aprovada.' : 'Compra recusada.', aprovar ? 'success' : 'info');
    }).catch(error => showToast('Erro ao registrar decisão: ' + error.message, 'error', 6500));
}

function receberFornecedores(snapshot) {
    fornecedores = snapshotParaLista(snapshot, child => ({ key: child.key, ...fornecedorNormalizado(child.val()) }));
    fornecedores.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    atualizarFiltroCategoriasFornecedores();
    atualizarSelectFornecedores();
    renderFornecedores();
    atualizarResumoOperacional();
    atualizarAlertasSistema();
}

function receberEncomendas(snapshot) {
    encomendas = snapshotParaLista(snapshot, child => ({ key: child.key, ...child.val() }));
    encomendas.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    encomendas
        .filter(pedido => pedido.status === 'Recebendo' && pedido.recebimentoClaim?.token)
        .forEach(pedido => recuperarRecebimentoEncomenda(pedido));
    renderEncomendas();
    renderFornecedores();
    atualizarResumoOperacional();
    atualizarAlertasSistema();
}

async function recuperarRecebimentoEncomenda(pedido) {
    const token = pedido.recebimentoClaim?.token;
    if (!pedido.key || !pedido.produtoKey || !token || recebimentosEncomendaEmRecuperacao.has(pedido.key)) return;
    const iniciadoEm = Date.parse(pedido.recebimentoClaim.iniciadoEm || '');
    if (!Number.isFinite(iniciadoEm)) return;

    recebimentosEncomendaEmRecuperacao.add(pedido.key);
    try {
        const agora = await agoraServidorConfiavel();
        const restante = 5 * 60_000 - (agora.getTime() - iniciadoEm);
        if (restante >= 0) {
            setTimeout(() => recuperarRecebimentoEncomenda(pedido), restante + 1_000);
            return;
        }

        const produtoSnapshot = await get(ref(db, `estoque/${pedido.produtoKey}`));
        const produto = produtoSnapshot.val();
        if (produto?.auditPending?.movimentoKey === token) {
            await reconciliarAuditoriaPendente({
                key: pedido.produtoKey,
                auditPending: produto.auditPending
            });
            return;
        }

        const movimentoSnapshot = produto?.recebimentos?.[pedido.key]
            ? await get(ref(db, `movimentacoes_estoque/${token}`))
            : null;
        await runTransaction(ref(db, `encomendas/${pedido.key}`), atual => {
            if (!atual || atual.status !== 'Recebendo' || atual.recebimentoClaim?.token !== token) return;
            const corrigido = { ...atual };
            delete corrigido.recebimentoClaim;
            if (movimentoSnapshot?.exists()) {
                corrigido.status = 'Recebido';
                corrigido.recebidoEm = produto.recebimentos[pedido.key];
                corrigido.recebidoPor = pedido.recebimentoClaim.iniciadoPor || '';
                corrigido.movimentoRecebimentoKey = token;
            } else {
                corrigido.status = 'Pedido enviado';
            }
            return corrigido;
        }, { applyLocally: false });
    } catch (error) {
        console.warn('Não foi possível recuperar um recebimento interrompido:', error.message);
    } finally {
        recebimentosEncomendaEmRecuperacao.delete(pedido.key);
    }
}

function iniciarListenersAdministrativos() {
    if (listenersAdministrativosAtivos || !auth.currentUser || !window.isAdmin) return;
    listenersAdministrativosAtivos = true;
    unsubscribeEstoque = onValue(ref(db, 'estoque'), receberEstoque, error => console.warn('Não foi possível carregar estoque:', error.message));
    unsubscribeMovimentos = onValue(ref(db, 'movimentacoes_estoque'), receberMovimentacoes, error => console.warn('Não foi possível carregar movimentações:', error.message));
    unsubscribeFornecedores = onValue(ref(db, 'fornecedores'), receberFornecedores, error => console.warn('Não foi possível carregar fornecedores:', error.message));
    unsubscribeEncomendas = onValue(ref(db, 'encomendas'), receberEncomendas, error => console.warn('Não foi possível carregar encomendas:', error.message));
}

document.getElementById('supplier-search')?.addEventListener('input', renderFornecedores);
document.getElementById('supplier-status-filter')?.addEventListener('change', renderFornecedores);
document.getElementById('supplier-category-filter')?.addEventListener('change', renderFornecedores);
document.getElementById('supplier-sort')?.addEventListener('change', renderFornecedores);
document.getElementById('btn-add-supplier')?.addEventListener('click', () => abrirModalFornecedor());
document.getElementById('supplier-modal-close')?.addEventListener('click', fecharModalFornecedor);
document.getElementById('supplier-modal-cancel')?.addEventListener('click', fecharModalFornecedor);
document.getElementById('supplier-form')?.addEventListener('submit', salvarFornecedor);
document.getElementById('supplier-modal')?.addEventListener('click', event => {
    if (event.target.id === 'supplier-modal') fecharModalFornecedor();
});
document.getElementById('order-search')?.addEventListener('input', () => { pedidosVisiveis = 12; renderEncomendas(); });
document.getElementById('order-status-filter')?.addEventListener('change', () => { pedidosVisiveis = 12; renderEncomendas(); });
document.getElementById('order-priority-filter')?.addEventListener('change', () => { pedidosVisiveis = 12; renderEncomendas(); });
document.getElementById('orders-load-more')?.addEventListener('click', () => { pedidosVisiveis += 12; renderEncomendas(); });
document.getElementById('report-search')?.addEventListener('input', () => { relatoriosVisiveis = 50; renderRelatoriosEstoque(); });
document.getElementById('report-type-filter')?.addEventListener('change', () => { relatoriosVisiveis = 50; renderRelatoriosEstoque(); });
document.getElementById('report-period-filter')?.addEventListener('change', () => { relatoriosVisiveis = 50; renderRelatoriosEstoque(); });
document.getElementById('reports-load-more')?.addEventListener('click', () => { relatoriosVisiveis += 50; renderRelatoriosEstoque(); });

function formatBRL(v) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));
}

const CHART_JS_URL = './vendor/chart.umd.min.js';
let chartJsPromise = null;
let pieChart = null;

function carregarChartJs() {
    if (chartJsPromise) return chartJsPromise;

    chartJsPromise = import(CHART_JS_URL)
        .then(() => {
            if (!window.Chart) throw new Error('Chart.js foi carregado sem expor o construtor esperado.');
            return window.Chart;
        })
        .catch(error => {
            chartJsPromise = null;
            throw error;
        });

    return chartJsPromise;
}

function graficoEstoqueAtivo() {
    return document.getElementById('page-controle-estoque')?.classList.contains('active') === true;
}

function setStockArText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function renderStockArFallback(reason) {
    const fallback = document.getElementById('stock-ar-fallback');
    const video = document.getElementById('stock-ar-video');
    if (!fallback) return;

    fallback.textContent = getCameraUnavailableMessage(reason);
    fallback.hidden = false;
    if (video) video.style.opacity = '0.18';
}

function renderStockArOverlay(product) {
    const model = buildStockArViewModel(product);
    const status = document.getElementById('stock-ar-status');

    setStockArText('stock-ar-product-name', model.name);
    setStockArText('stock-ar-summary', model.summary);
    setStockArText('stock-ar-quantity', model.quantityLabel);
    setStockArText('stock-ar-minimum', model.minimumLabel);
    setStockArText('stock-ar-cost', model.costLabel);
    setStockArText('stock-ar-sale', model.saleLabel);
    setStockArText('stock-ar-margin', model.marginLabel);
    setStockArText('stock-ar-recommendation', model.recommendation);

    if (status) {
        status.textContent = model.status.label;
        status.className = `stock-ar-status ${model.status.tone}`;
    }
}

async function openStockArViewer(product) {
    const session = ++stockArSession;
    const modalAr = document.getElementById('stock-ar-modal');
    const video = document.getElementById('stock-ar-video');
    const fallback = document.getElementById('stock-ar-fallback');
    if (!modalAr) return;

    stockArProduct = product;
    renderStockArOverlay(product);
    if (fallback) {
        fallback.hidden = true;
        fallback.textContent = '';
    }
    if (video) video.style.opacity = '';

    exibirDialogo(modalAr, '#close-stock-ar');

    const support = detectCameraSupport(window);
    if (!support.supported) {
        renderStockArFallback(support.reason);
        return;
    }

    if (stockArCameraController) stockArCameraController.stop();
    const cameraController = createStockArCameraController({
        videoElement: video,
        mediaDevices: navigator.mediaDevices
    });
    stockArCameraController = cameraController;

    const camera = await cameraController.start();
    if (session !== stockArSession || stockArCameraController !== cameraController) {
        cameraController.stop();
        return;
    }
    if (!camera.ok) renderStockArFallback(camera.reason);
}

function closeStockArViewer(restaurarFoco = true) {
    const modalAr = document.getElementById('stock-ar-modal');
    stockArSession += 1;
    if (stockArCameraController) stockArCameraController.stop();
    stockArCameraController = null;
    stockArProduct = null;
    ocultarDialogo(modalAr, restaurarFoco);
}

function renderEstoque(lista) {
    const tbody = document.getElementById('table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!lista.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94A3B8;padding:24px;">Nenhum produto encontrado.</td></tr>';
    }

    lista.forEach(p => {
        const cls = p.qty <= p.minQty ? 'stock-low' : (p.qty <= p.minQty * 1.5 ? 'stock-medium' : 'stock-high');
        const tr  = document.createElement('tr');
        tr.classList.add(cls);

        const td1 = document.createElement('td'); td1.textContent = p.name;
        const td2 = document.createElement('td'); td2.textContent = p.category;
        const td3 = document.createElement('td'); td3.textContent = p.qty;
        const td4 = document.createElement('td'); td4.textContent = p.minQty;
        const td5 = document.createElement('td'); td5.innerHTML = `<strong>${formatBRL(p.price)}</strong><br><small>Venda: ${formatBRL(p.salePrice)}</small>`;

        const td6 = document.createElement('td');
        td6.className = 'inventory-row-actions-cell';
        const rowActions = document.createElement('div');
        rowActions.className = 'inventory-row-actions';
        const btnMove = document.createElement('button');
        btnMove.textContent = 'Movimentar';
        btnMove.className = 'inventory-row-action inventory-row-action-primary';
        btnMove.addEventListener('click', () => abrirMovimentacaoEstoque(p));
        const btnAr = document.createElement('button');
        btnAr.textContent = 'Ver em AR';
        btnAr.setAttribute('aria-label', `Ver ${p.name} em realidade aumentada`);
        btnAr.className = 'inventory-row-action';
        btnAr.addEventListener('click', () => openStockArViewer(p));
        const btnEdit = document.createElement('button');
        btnEdit.textContent = 'Editar';
        btnEdit.className = 'inventory-row-action';
        btnEdit.addEventListener('click', () => preencherFormularioProduto(p));

        const btnDel = document.createElement('button');
        btnDel.textContent = 'Excluir';
        btnDel.className = 'inventory-row-action danger-inline';
        btnDel.addEventListener('click', () => excluirProduto(p));
        if (p.auditPending) {
            [btnMove, btnEdit, btnDel].forEach(botao => {
                botao.disabled = true;
                botao.title = 'Aguardando sincronização da auditoria';
            });
        }
        rowActions.append(btnMove, btnAr, btnEdit, btnDel);
        td6.appendChild(rowActions);

        tr.append(td1, td2, td3, td4, td5, td6);
        tbody.appendChild(tr);
    });

    const m = metricasEstoque();
    const totalEl = document.getElementById('info-total');
    const catEl   = document.getElementById('info-categorias');
    const lowEl   = document.getElementById('info-baixo');
    const valorEl = document.getElementById('info-valor-total');
    const timeEl  = document.getElementById('update-time');
    if (totalEl && totalEl.textContent !== String(m.total)) { totalEl.textContent = m.total; piscarMetrica('info-total'); }
    if (catEl && catEl.textContent !== String(m.categorias)) { catEl.textContent = m.categorias; piscarMetrica('info-categorias'); }
    if (lowEl && lowEl.textContent !== String(m.baixo)) { lowEl.textContent = m.baixo; piscarMetrica('info-baixo'); }
    const valorFinanceiro = visaoFinanceira === 'custo' ? m.valorTotal : m.faturamentoTotal;
    if (valorEl && valorEl.textContent !== formatBRL(valorFinanceiro)) {
        valorEl.textContent = formatBRL(valorFinanceiro);
        piscarMetrica('info-valor-total');
    }
    const tituloFinanceiro = document.getElementById('financial-view-title');
    const botaoFinanceiro = document.getElementById('toggle-financial-view');
    if (tituloFinanceiro) tituloFinanceiro.textContent = visaoFinanceira === 'custo' ? 'Custo em Estoque' : 'Faturamento Estimado';
    if (botaoFinanceiro) botaoFinanceiro.textContent = visaoFinanceira === 'custo' ? 'Alternar para faturamento' : 'Alternar para custo';
    if (timeEl)  timeEl.textContent  = 'Última atualização: ' + new Date().toLocaleString('pt-BR');

    if (graficoEstoqueAtivo()) {
        atualizarGrafico(lista);
    }
}

function renderDashboardEstoque() {
    const m = metricasEstoque();
    const setText = (id, valor) => {
        const el = document.getElementById(id);
        if (el && el.textContent !== String(valor)) {
            el.textContent = valor;
            piscarMetrica(id);
        }
    };
    setText('dash-total-produtos', m.total);
    setText('dash-categorias', m.categorias);
    setText('dash-estoque-baixo', m.baixo);
    setText('dash-total-produtos-row', m.total + ' itens');
    setText('dash-categorias-row', m.categorias);
    setText('dash-estoque-baixo-row', m.baixo);
    setText('dash-quantidade-row', m.quantidadeTotal + ' unidades');
    setText('dash-valor-row', formatBRL(m.valorTotal));
    setText('dash-revenue', formatBRL(m.faturamentoTotal));
    setText('dash-margin', formatBRL(m.margemTotal));
    setText('dash-revenue-row', formatBRL(m.faturamentoTotal));
    setText('dash-margin-row', formatBRL(m.margemTotal));
}

function renderRelatoriosEstoque() {
    const tbody = document.getElementById('relatorios-body');
    if (!tbody) return;
    const busca = document.getElementById('report-search')?.value || '';
    const tipo = document.getElementById('report-type-filter')?.value || '';
    const periodo = document.getElementById('report-period-filter')?.value || 'all';
    const agora = new Date();
    const filtrados = movimentosEstoque.filter(item => {
        const correspondePeriodo = periodo === 'all' || timestampNoPeriodoCalendario(item.timestamp, periodo, agora);
        return correspondePeriodo &&
            (!tipo || item.tipo === tipo) &&
            matchesSearch(item, busca, ['name', 'category', 'destinatarioNome', 'destinatarioMatricula', 'operadorNome', 'usuario', 'observacao']);
    });
    const pagina = paginate(filtrados, 1, relatoriosVisiveis);
    setResultCount('report-result-count', filtrados.length, 'movimentação', 'movimentações');
    const loadMore = document.getElementById('reports-load-more');
    if (loadMore) loadMore.hidden = pagina.items.length >= filtrados.length;
    tbody.innerHTML = '';

    if (!filtrados.length) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94A3B8;padding:24px;">${movimentosEstoque.length ? 'Nenhuma movimentação corresponde aos filtros.' : 'Nenhuma movimentação registrada.'}</td></tr>`;
        return;
    }

    pagina.items.forEach(mov => {
        const tr = document.createElement('tr');
        const data = mov.timestamp ? new Date(mov.timestamp).toLocaleString('pt-BR') : '-';
        const saldo = mov.saldoAnterior === undefined && mov.saldoAtual === undefined
            ? '-'
            : `${mov.saldoAnterior ?? '-'} → ${mov.saldoAtual ?? '-'}`;
        [
            mov.name || '-',
            mov.category || '-',
            mov.tipo || '-',
            mov.qty ?? '-',
            saldo,
            mov.destinatarioNome || mov.destinatarioMatricula || '-',
            mov.operadorNome
                ? `${mov.operadorNome}${mov.operadorMatricula ? ` (${mov.operadorMatricula})` : ''}`
                : mov.usuario || '-',
            mov.observacao || '-',
            data
        ].forEach(valor => {
            const td = document.createElement('td');
            td.textContent = valor;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    applyColumnPreferences('report-table');
}

async function atualizarGrafico(lista = products) {
    const canvas = document.getElementById('pieChart');
    if (!canvas) return;

    const cats = [...new Set(lista.map(p => p.category).filter(Boolean))];
    const totals = cats.map(c =>
        lista.filter(p => p.category === c).reduce((s, p) => s + Number(p.qty || 0), 0)
    );
    const resumo = document.getElementById('stock-category-chart-summary');
    if (resumo) {
        resumo.textContent = cats.length
            ? cats.map((categoria, indice) => `${categoria}: ${totals[indice]} unidade(s)`).join('; ') + '.'
            : 'Não há produtos para resumir por categoria.';
    }

    let ChartConstructor;
    try {
        ChartConstructor = await carregarChartJs();
    } catch (error) {
        console.warn(error.message);
        return;
    }

    if (pieChart) {
        pieChart.data.labels = cats;
        pieChart.data.datasets[0].data = totals;
        pieChart.update();
        return;
    }
    pieChart = new ChartConstructor(canvas, {
        type: 'pie',
        data: {
            labels: cats,
            datasets: [{ data: totals,
                backgroundColor: ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}

function atualizarFiltroCategorias() {
    const select = document.getElementById('filter-category');
    if (!select) return;
    const atual = select.value;
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.innerHTML = '';
    const todas = document.createElement('option');
    todas.value = '';
    todas.textContent = 'Todas as categorias';
    select.appendChild(todas);
    cats.forEach(categoria => {
        const option = document.createElement('option');
        option.value = categoria;
        option.textContent = categoria;
        select.appendChild(option);
    });
    select.value = cats.includes(atual) ? atual : '';
}

function atualizarSelectProdutosEncomenda() {
    const select = document.getElementById('enc-produto-estoque');
    if (!select) return;
    const atual = select.value;
    select.innerHTML = '<option value="">Selecione um produto cadastrado</option>';
    products.forEach(produto => {
        const option = new Option(`${produto.name} · saldo ${produto.qty}`, produto.key);
        option.dataset.category = produto.category || '';
        select.appendChild(option);
    });
    select.value = products.some(produto => produto.key === atual) ? atual : '';
}

document.getElementById('enc-produto-estoque')?.addEventListener('change', event => {
    const produto = products.find(item => item.key === event.target.value);
    if (!produto) return;
    const nome = document.getElementById('enc-produto');
    const categoria = document.getElementById('enc-categoria');
    if (nome) nome.value = produto.name;
    if (categoria) categoria.value = produto.category || '';
});

const searchEl = document.getElementById('search');
if (searchEl) {
    searchEl.addEventListener('input', () => renderEstoque(getListaEstoqueVisivel()));
}
const categoryFilter = document.getElementById('filter-category');
if (categoryFilter) {
    categoryFilter.addEventListener('change', () => renderEstoque(getListaEstoqueVisivel()));
}

const btnAdd   = document.getElementById('btn-add');
const modal    = document.getElementById('modal');
const saveProd = document.getElementById('save-product');

function fecharFormularioProduto() {
    ocultarDialogo(modal);
    limparFormularioProduto();
}

function limparFormularioProduto() {
    produtoEditandoKey = null;
    const titulo = document.getElementById('modal-title');
    if (titulo) titulo.textContent = 'Adicionar Produto';
    if (saveProd) saveProd.textContent = 'Salvar Produto';
    const quantidade = document.getElementById('p-qty');
    if (quantidade) quantidade.disabled = false;
    ['p-name', 'p-category', 'p-qty', 'p-min-qty', 'p-price', 'p-sale-price'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function preencherFormularioProduto(produto) {
    produtoEditandoKey = produto.key;
    document.getElementById('p-name').value = produto.name;
    const categoria = document.getElementById('p-category');
    if (categoria) categoria.value = produto.category;
    document.getElementById('p-qty').value = produto.qty;
    document.getElementById('p-min-qty').value = produto.minQty;
    document.getElementById('p-price').value = produto.price;
    document.getElementById('p-sale-price').value = produto.salePrice;
    document.getElementById('p-qty').disabled = true;
    const titulo = document.getElementById('modal-title');
    if (titulo) titulo.textContent = 'Editar Produto — quantidade somente em Movimentar';
    if (saveProd) saveProd.textContent = 'Atualizar Produto';
    exibirDialogo(modal, '#p-name');
}

function validarProduto(produto) {
    if (!produto.name) return 'Informe o nome do produto.';
    if (!produto.category) return 'Informe a categoria do produto.';
    if (!Number.isInteger(produto.qty) || produto.qty < 0) return 'Informe uma quantidade inteira válida.';
    if (!Number.isInteger(produto.minQty) || produto.minQty < 0) return 'Informe um estoque mínimo inteiro válido.';
    if (!Number.isFinite(produto.price) || produto.price < 0) return 'Informe um preço válido.';
    if (!Number.isFinite(produto.salePrice) || produto.salePrice < 0) return 'Informe um preço de venda válido.';
    return '';
}

function produtoParaPersistir(produto) {
    const persistido = { ...produto };
    delete persistido.key;
    if (!persistido.auditPending) delete persistido.auditPending;
    return persistido;
}

function atualizarProdutoComHistorico(produtoKey, produtoPersistido, tipo, produtoHistorico, extra = {}) {
    const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
    const registro = montarRegistroMovimentacaoEstoque(tipo, produtoHistorico, extra, movimentoKey);
    return update(ref(db), {
        [`estoque/${produtoKey}`]: produtoPersistido,
        [`movimentacoes_estoque/${movimentoKey}`]: registro,
        [`historico_estoque/${movimentoKey}`]: registro
    });
}

async function atualizarMetadadosProdutoComHistorico(produtoKey, novosDados) {
    const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
    let motivoCancelamento = 'O produto foi alterado ou excluído. Atualize a página e tente novamente.';
    const resultado = await runTransaction(ref(db, `estoque/${produtoKey}`), atual => {
        if (!atual) return;
        if (atual.auditPending) {
            motivoCancelamento = 'Existe uma auditoria pendente para este produto. Aguarde a sincronização antes de editar.';
            return;
        }
        const anterior = produtoNormalizado(atual);
        const atualizado = { ...anterior, ...novosDados, qty: anterior.qty, key: produtoKey };
        const registro = montarRegistroMovimentacaoEstoque('Edição', atualizado, {
            anterior: produtoParaPersistir(anterior),
            atual: produtoParaPersistir(atualizado)
        }, movimentoKey);
        return {
            ...atual,
            ...produtoParaPersistir(atualizado),
            auditPending: { movimentoKey, registro }
        };
    }, { applyLocally: false });

    if (!resultado.committed) throw new Error(motivoCancelamento);
    const pendente = resultado.snapshot.val()?.auditPending;
    try {
        await persistirRegistroMovimentacaoEstoque(pendente.registro, movimentoKey);
        await runTransaction(ref(db, `estoque/${produtoKey}`), atual => {
            if (!atual || atual.auditPending?.movimentoKey !== movimentoKey) return;
            const corrigido = { ...atual };
            delete corrigido.auditPending;
            return corrigido;
        }, { applyLocally: false });
    } catch (error) {
        console.warn('Produto atualizado com auditoria pendente:', error.message);
        showToast('O produto foi atualizado; a auditoria será sincronizada automaticamente.', 'info', 6500);
    }
}

async function salvarProduto() {
    const produto = produtoNormalizado({
        name: document.getElementById('p-name').value,
        category: document.getElementById('p-category').value,
        qty: document.getElementById('p-qty').value,
        minQty: document.getElementById('p-min-qty').value,
        price: document.getElementById('p-price').value,
        salePrice: document.getElementById('p-sale-price').value
    });
    const erro = validarProduto(produto);
    if (erro) { showToast(erro, 'error', 6000); return; }

    if (saveProd) saveProd.disabled = true;
    try {
        if (produtoEditandoKey) {
            const anterior = products.find(item => item.key === produtoEditandoKey);
            if (!anterior) throw new Error('O produto foi alterado ou excluído. Atualize a página e tente novamente.');
            if (anterior.auditPending) throw new Error('Existe uma auditoria pendente para este produto. Aguarde a sincronização antes de editar.');
            await atualizarMetadadosProdutoComHistorico(produtoEditandoKey, produto);
        } else {
            const novoRef = push(ref(db, 'estoque'));
            const produtoComKey = { ...produto, key: novoRef.key };
            await atualizarProdutoComHistorico(
                novoRef.key,
                produtoParaPersistir(produtoComKey),
                'Entrada',
                produtoComKey,
                { saldoAnterior: 0, saldoAtual: produtoComKey.qty, origem: 'cadastro_produto' }
            );
        }
        ocultarDialogo(modal);
        limparFormularioProduto();
    } catch (error) {
        showToast('Erro ao salvar produto: ' + error.message, 'error', 6000);
    } finally {
        if (saveProd) saveProd.disabled = false;
    }
}

function atualizarSelectDestinatarios() {
    const select = document.getElementById('stock-movement-employee');
    if (!select) return;
    const valor = select.value;
    select.innerHTML = '<option value="">Sem destinatário específico</option>';
    funcionariosCache
        .filter(item => item.uid)
        .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'))
        .forEach(item => {
            const option = document.createElement('option');
            option.value = item.uid;
            option.textContent = `${item.nome || 'Funcionário'} · ${item.matricula}`;
            option.dataset.nome = item.nome || '';
            option.dataset.matricula = item.matricula || '';
            select.appendChild(option);
        });
    if ([...select.options].some(option => option.value === valor)) select.value = valor;
}

function abrirMovimentacaoEstoque(produto) {
    produtoMovimentando = produto;
    const modalMov = document.getElementById('stock-movement-modal');
    if (!modalMov) return;
    document.getElementById('stock-movement-product').textContent = `${produto.name} · saldo atual: ${produto.qty}`;
    document.getElementById('stock-movement-type').value = 'Entrada';
    document.getElementById('stock-movement-qty').value = '1';
    document.getElementById('stock-movement-employee').value = '';
    document.getElementById('stock-movement-note').value = '';
    exibirDialogo(modalMov, '#stock-movement-type');
}

function fecharMovimentacaoEstoque() {
    const modalMov = document.getElementById('stock-movement-modal');
    ocultarDialogo(modalMov);
    produtoMovimentando = null;
}

async function salvarMovimentacaoEstoque() {
    if (!produtoMovimentando) return;
    const tipo = document.getElementById('stock-movement-type').value;
    const quantidade = Number(document.getElementById('stock-movement-qty').value || 0);
    const destinatarioSelect = document.getElementById('stock-movement-employee');
    const destinatarioOption = destinatarioSelect.options[destinatarioSelect.selectedIndex];
    if (!Number.isInteger(quantidade) || quantidade <= 0) {
        showToast('Informe uma quantidade inteira válida.', 'error', 6000);
        return;
    }
    const saveButton = document.getElementById('save-stock-movement');
    if (saveButton) saveButton.disabled = true;
    let motivoCancelamento = 'O produto foi alterado ou excluído. Atualize a página e tente novamente.';
    const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
    try {
        const resultado = await runTransaction(ref(db, 'estoque/' + produtoMovimentando.key), atual => {
            if (!atual) return;
            if (atual.auditPending) {
                motivoCancelamento = 'Existe uma auditoria pendente para este produto. Aguarde alguns segundos e tente novamente.';
                return;
            }
            const produtoAtual = produtoNormalizado(atual);
            if (tipo === 'Retirada' && quantidade > produtoAtual.qty) {
                motivoCancelamento = 'A retirada é maior que o saldo disponível.';
                return;
            }
            const novoSaldo = tipo === 'Entrada'
                ? produtoAtual.qty + quantidade
                : produtoAtual.qty - quantidade;
            const registro = montarRegistroMovimentacaoEstoque(tipo, {
                ...produtoAtual,
                key: produtoMovimentando.key,
                qty: quantidade
            }, {
                saldoAnterior: produtoAtual.qty,
                saldoAtual: novoSaldo,
                destinatarioUid: tipo === 'Retirada' ? destinatarioSelect.value : '',
                destinatarioNome: tipo === 'Retirada' ? (destinatarioOption?.dataset.nome || '') : '',
                destinatarioMatricula: tipo === 'Retirada' ? (destinatarioOption?.dataset.matricula || '') : '',
                observacao: document.getElementById('stock-movement-note').value.trim()
            }, movimentoKey);
            return {
                ...atual,
                ...produtoParaPersistir(produtoAtual),
                qty: novoSaldo,
                auditPending: { movimentoKey, registro }
            };
        }, { applyLocally: false });
        if (!resultado.committed) {
            showToast(motivoCancelamento, 'error', 7000);
            return;
        }
        const pendente = resultado.snapshot.val()?.auditPending;
        try {
            await persistirRegistroMovimentacaoEstoque(pendente.registro, movimentoKey);
            await runTransaction(ref(db, 'estoque/' + produtoMovimentando.key), atual => {
                if (!atual || atual.auditPending?.movimentoKey !== movimentoKey) return;
                const corrigido = { ...atual };
                delete corrigido.auditPending;
                return corrigido;
            }, { applyLocally: false });
        } catch (error) {
            console.warn('Saldo atualizado com auditoria pendente:', error.message);
            showToast('O saldo foi atualizado, mas a auditoria ficou pendente e será sincronizada automaticamente.', 'info', 7000);
        }
        fecharMovimentacaoEstoque();
    } catch (error) {
        showToast('Erro ao registrar movimentação: ' + error.message, 'error', 6000);
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

async function excluirProduto(produto) {
    if (!produto.key) return;
    const confirmacao = await requestDecision({
        title: 'Excluir produto',
        description: `${produto.name} · O item só será removido se não houver encomenda aberta nem auditoria pendente.`,
        confirmText: 'Excluir produto',
        danger: true
    });
    if (confirmacao === null) return;

    try {
        const pedidosSnapshot = await get(ref(db, 'encomendas'));
        const possuiPedidoAberto = snapshotParaLista(pedidosSnapshot, child => ({ key: child.key, ...child.val() }))
            .some(pedido => pedido.produtoKey === produto.key && pedidoEmAberto(pedido));
        if (possuiPedidoAberto) {
            throw new Error('Existe uma encomenda aberta para este produto. Conclua ou cancele o pedido antes de removê-lo.');
        }

        const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
        let motivoCancelamento = 'O produto foi alterado ou removido por outro usuário.';
        const resultado = await runTransaction(ref(db, `estoque/${produto.key}`), atual => {
            if (!atual) return;
            if (atual.auditPending) {
                motivoCancelamento = 'Existe uma auditoria pendente para este produto. Aguarde a sincronização antes de excluir.';
                return;
            }
            const produtoAtual = { ...produtoNormalizado(atual), key: produto.key };
            const registro = montarRegistroMovimentacaoEstoque('Exclusão', produtoAtual, {
                saldoAnterior: produtoAtual.qty,
                saldoAtual: 0
            }, movimentoKey);
            return {
                ...atual,
                auditPending: { movimentoKey, registro, excluirProduto: true }
            };
        }, { applyLocally: false });
        if (!resultado.committed) throw new Error(motivoCancelamento);

        await reconciliarAuditoriaPendente({
            key: produto.key,
            auditPending: resultado.snapshot.val()?.auditPending
        });
        showToast('Produto excluído com o histórico preservado.', 'info');
    } catch (error) {
        showToast('Erro ao excluir produto: ' + error.message, 'error', 6500);
    }
}

if (btnAdd && modal) {
    btnAdd.addEventListener('click', () => {
        limparFormularioProduto();
        exibirDialogo(modal, '#p-name');
    });
    modal.addEventListener('click', e => {
        if (e.target === modal) {
            fecharFormularioProduto();
        }
    });
}
document.getElementById('product-modal-close')?.addEventListener('click', fecharFormularioProduto);
document.getElementById('cancel-product')?.addEventListener('click', fecharFormularioProduto);
if (saveProd) saveProd.addEventListener('click', salvarProduto);
document.getElementById('save-stock-movement')?.addEventListener('click', salvarMovimentacaoEstoque);
document.getElementById('cancel-stock-movement')?.addEventListener('click', fecharMovimentacaoEstoque);
document.getElementById('stock-movement-modal')?.addEventListener('click', event => {
    if (event.target.id === 'stock-movement-modal') fecharMovimentacaoEstoque();
});
document.getElementById('close-stock-ar')?.addEventListener('click', closeStockArViewer);
document.getElementById('stock-ar-close-secondary')?.addEventListener('click', closeStockArViewer);
document.getElementById('stock-ar-modal')?.addEventListener('click', event => {
    if (event.target.id === 'stock-ar-modal') closeStockArViewer();
});
document.getElementById('stock-ar-open-movement')?.addEventListener('click', () => {
    const product = stockArProduct;
    closeStockArViewer();
    if (product) abrirMovimentacaoEstoque(product);
});

document.getElementById('ponto-periodo')?.addEventListener('change', renderPainelPonto);
document.getElementById('management-search')?.addEventListener('input', renderPainelPonto);
document.getElementById('management-status-filter')?.addEventListener('change', renderPainelPonto);
document.getElementById('management-sector-filter')?.addEventListener('change', renderPainelPonto);
[
    ['.card-servico', 'active'],
    ['.card-atraso', 'late'],
    ['.card-pendencia', 'pending']
].forEach(([selector, status]) => {
    const card = document.querySelector(`#page-gerenciamento-ponto ${selector}`);
    if (!card) return;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const aplicar = () => {
        const filter = document.getElementById('management-status-filter');
        if (filter) filter.value = status;
        renderPainelPonto();
        document.getElementById('tabela-corpo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    card.addEventListener('click', aplicar);
    card.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        aplicar();
    });
});
document.getElementById('ponto-periodo')?.addEventListener('change', event => {
    const personalizado = event.target.value === 'personalizado';
    const inicio = document.getElementById('ponto-data-inicio');
    const fim = document.getElementById('ponto-data-fim');
    if (inicio) inicio.hidden = !personalizado;
    if (fim) fim.hidden = !personalizado;
});
document.getElementById('ponto-data-inicio')?.addEventListener('change', renderPainelPonto);
document.getElementById('ponto-data-fim')?.addEventListener('change', renderPainelPonto);
document.getElementById('btn-imprimir-ponto')?.addEventListener('click', imprimirEspelhoPonto);

function atualizarControlesPowerBi() {
    const dataset = document.getElementById('power-bi-dataset')?.value;
    const period = document.getElementById('power-bi-period');
    if (period) period.disabled = dataset === 'estoque';
}

async function exportarPowerBi() {
    if (!window.isAdmin) {
        showToast('Somente administradores podem exportar dados para análise.', 'error');
        return;
    }

    const tipo = document.getElementById('power-bi-dataset')?.value || 'ponto';
    const periodo = document.getElementById('power-bi-period')?.value || 'mes_atual';
    const privacidade = document.getElementById('power-bi-privacy')?.value || 'pseudonimizado';

    if (privacidade === 'identificado') {
        const confirmation = await requestDecision({
            title: 'Exportar dados identificados',
            description: 'O arquivo poderá conter nomes e matrículas. Guarde-o em local seguro.',
            confirmText: 'Gerar arquivo'
        });
        if (confirmation === null) return;
    }

    try {
        const dataset = montarDatasetPowerBi(tipo, {
            registrosPonto: registrosPontoCache,
            produtos: products,
            movimentos: movimentosEstoque
        }, {
            periodo,
            privacidade,
            agora: new Date()
        });

        if (!dataset.linhas.length) {
            showToast('Não há dados para o conjunto e período selecionados.', 'info');
            return;
        }

        baixarCSV(dataset.nomeArquivo, dataset.cabecalhos, dataset.linhas, {
            separador: ',',
            preservarNumeros: true
        });
        const ignored = dataset.ignorados
            ? ` ${dataset.ignorados} registro(s) inválido(s) foram ignorados.`
            : '';
        showToast(`Arquivo preparado para o Power BI.${ignored}`);
    } catch (error) {
        showToast('Não foi possível gerar o arquivo: ' + error.message, 'error', 6500);
    }
}

document.getElementById('power-bi-dataset')?.addEventListener('change', atualizarControlesPowerBi);
document.getElementById('btn-exportar-power-bi')?.addEventListener('click', exportarPowerBi);
atualizarControlesPowerBi();
document.getElementById('btn-exportar-ponto-csv')?.addEventListener('click', () => exportarPontoCSV());
document.getElementById('btn-export-my-points')?.addEventListener('click', () => exportarPontoCSV(meusRegistrosVisiveis(), 'meu-espelho-ponto.csv'));
document.getElementById('btn-exportar-historico-ponto')?.addEventListener('click', () => {
    baixarCSV('auditoria-ponto.csv', ['Ação', 'Funcionário', 'Matrícula', 'Registro', 'Responsável', 'Data'], historicoPontoCache.map(item => [
        item.acao,
        item.atual?.nome || item.anterior?.nome,
        item.atual?.matricula || item.anterior?.matricula,
        item.registroKey,
        item.responsavelEmail,
        item.timestamp ? new Date(item.timestamp).toLocaleString('pt-BR') : ''
    ]));
});
document.getElementById('btn-comprovante-ponto')?.addEventListener('click', baixarComprovantePonto);
document.getElementById('save-edit-ponto')?.addEventListener('click', salvarEdicaoPonto);
document.getElementById('cancel-edit-ponto')?.addEventListener('click', fecharEditorPonto);
document.getElementById('btn-imprimir-estoque')?.addEventListener('click', imprimirEstoque);
document.getElementById('btn-exportar-estoque-csv')?.addEventListener('click', () => {
    baixarCSV('estoque-checklog.csv', ['Produto', 'Categoria', 'Quantidade', 'Estoque mínimo', 'Custo', 'Venda', 'Margem unitária'], products.map(item => [
        item.name, item.category, item.qty, item.minQty, item.price, item.salePrice, item.salePrice - item.price
    ]));
});
document.getElementById('btn-exportar-relatorios-csv')?.addEventListener('click', () => {
    baixarCSV('movimentacoes-estoque.csv', ['Produto', 'Categoria', 'Tipo', 'Quantidade', 'Saldo anterior', 'Saldo atual', 'Destinatário', 'Matrícula destinatário', 'Operador', 'Matrícula operador', 'E-mail operador', 'Observação', 'Data'], movimentosEstoque.map(item => [
        item.name, item.category, item.tipo, item.qty, item.saldoAnterior, item.saldoAtual, item.destinatarioNome, item.destinatarioMatricula, item.operadorNome, item.operadorMatricula, item.usuario, item.observacao, item.timestamp ? new Date(item.timestamp).toLocaleString('pt-BR') : ''
    ]));
});
document.getElementById('toggle-financial-view')?.addEventListener('click', () => {
    visaoFinanceira = visaoFinanceira === 'custo' ? 'faturamento' : 'custo';
    renderEstoque(getListaEstoqueVisivel());
});
document.getElementById('card-itens-criticos')?.addEventListener('click', abrirItensCriticos);
document.getElementById('card-itens-criticos')?.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    abrirItensCriticos();
});
document.getElementById('close-criticos')?.addEventListener('click', fecharItensCriticos);

function abrirItensCriticos() {
    const modal = document.getElementById('criticos-modal');
    const lista = document.getElementById('criticos-lista');
    if (!modal || !lista) return;
    const criticos = products.filter(p => Number(p.qty) <= Number(p.minQty || 0));
    lista.innerHTML = '';
    if (!criticos.length) {
        lista.appendChild(criarElemento('p', 'muted-note', 'Nenhum item crítico no momento.'));
    } else {
        const table = document.createElement('table');
        const caption = criarElemento('caption', 'sr-only', 'Produtos com estoque igual ou abaixo do mínimo');
        const thead = document.createElement('thead');
        const header = document.createElement('tr');
        ['Produto', 'Categoria', 'Qtd.', 'Mínimo'].forEach(texto => {
            const th = criarElemento('th', '', texto);
            th.scope = 'col';
            header.appendChild(th);
        });
        thead.appendChild(header);
        const tbody = document.createElement('tbody');
        criticos.forEach(produto => {
            const row = document.createElement('tr');
            [produto.name, produto.category, produto.qty, produto.minQty].forEach(valor => row.appendChild(criarElemento('td', '', valor)));
            tbody.appendChild(row);
        });
        table.append(caption, thead, tbody);
        lista.appendChild(table);
    }
    exibirDialogo(modal, '#close-criticos');
}

function fecharItensCriticos() {
    const modal = document.getElementById('criticos-modal');
    ocultarDialogo(modal);
}

function imprimirEstoque() { window.print(); }
const formEncomenda = document.getElementById('form-encomenda');
if (formEncomenda) {
    formEncomenda.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitButton = formEncomenda.querySelector('button[type="submit"]');
        if (submitButton?.disabled) return;
        const fornecedorKey = document.getElementById('enc-fornecedor').value;
        const fornecedor = fornecedorPorKey(fornecedorKey);
        const produtoKey = document.getElementById('enc-produto-estoque').value;
        const produtoEstoque = products.find(item => item.key === produtoKey);
        const valorEstimado = Number(document.getElementById('enc-valor-estimado').value || 0);
        const pedido = {
            responsavel: document.getElementById('enc-responsavel').value.trim(),
            category: document.getElementById('enc-categoria').value.trim(),
            produto: document.getElementById('enc-produto').value.trim(),
            produtoKey,
            quantidade: Number(document.getElementById('enc-quantidade').value || 1),
            prioridade: document.getElementById('enc-prioridade').value,
            fornecedorKey,
            fornecedor: fornecedor?.name || '',
            dataNecessaria: document.getElementById('enc-data-necessaria').value,
            valorEstimado: Math.round((valorEstimado + Number.EPSILON) * 100) / 100,
            anexo: document.getElementById('enc-anexo').value.trim(),
            observacoes: document.getElementById('enc-observacoes').value.trim(),
            status: Number(document.getElementById('enc-valor-estimado').value || 0) >= 1000 ? 'Aguardando aprovação' : 'Solicitado',
            timestamp: new Date().toISOString(),
            usuario: auth.currentUser?.email || ''
        };
        if (!pedido.responsavel || !pedido.category || !pedido.produto || !produtoEstoque || !pedido.fornecedor || !Number.isInteger(pedido.quantidade) || pedido.quantidade < 1) {
            showToast('Preencha todos os campos da encomenda.', 'error', 6000);
            return;
        }
        if (!Number.isFinite(valorEstimado) || valorEstimado < 0) {
            showToast('Informe um valor estimado válido.', 'error', 6000);
            return;
        }
        if (pedido.anexo && !/^https:\/\//i.test(pedido.anexo)) {
            showToast('Use um link seguro iniciado por https:// para a cotação ou o anexo.', 'error', 6000);
            return;
        }
        if (submitButton) submitButton.disabled = true;
        try {
            const pedidoRef = push(ref(db, 'encomendas'));
            const movimentoKey = push(ref(db, 'movimentacoes_estoque')).key;
            const registroMovimento = montarRegistroMovimentacaoEstoque('Encomenda', {
                key: pedido.produtoKey,
                name: pedido.produto,
                category: pedido.category,
                qty: pedido.quantidade,
                price: produtoEstoque.price,
                salePrice: produtoEstoque.salePrice
            }, { pedidoKey: pedidoRef.key, fornecedor: pedido.fornecedor, responsavel: pedido.responsavel }, movimentoKey);
            await update(ref(db), {
                [`encomendas/${pedidoRef.key}`]: pedido,
                [`movimentacoes_estoque/${movimentoKey}`]: registroMovimento,
                [`historico_estoque/${movimentoKey}`]: registroMovimento
            });
            const msg = document.getElementById('mensagemEncomenda');
            if (msg) {
                msg.style.color = '#059669';
                msg.textContent = pedido.status === 'Aguardando aprovação'
                    ? 'Solicitação criada e enviada para aprovação.'
                    : 'Solicitação criada com sucesso.';
            }
            showToast(pedido.status === 'Aguardando aprovação' ? 'Solicitação enviada para aprovação.' : 'Solicitação criada com sucesso.');
            formEncomenda.reset();
            atualizarSelectFornecedores();
            atualizarSelectProdutosEncomenda();
        } catch (error) {
            const msg = document.getElementById('mensagemEncomenda');
            if (msg) {
                msg.style.color = '#DC2626';
                msg.textContent = 'Erro ao enviar pedido: ' + error.message;
            }
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });
}
// Rotação automática dos carrosséis.
let carrosselCount = 1;
setInterval(() => {
    const activePage = document.querySelector('.page.active');
    if (!activePage || (activePage.id !== 'page-pagina-inicial' && activePage.id !== 'page-registrar_ponto')) return;

    carrosselCount = carrosselCount >= 2 ? 1 : carrosselCount + 1;
    const elA = document.getElementById('s' + carrosselCount);
    const elB = document.getElementById('s' + carrosselCount + '_ponto');
    if (elA) elA.checked = true;
    if (elB) elB.checked = true;
}, 3000);

// Chatbot contextual por página.
const FLUXOS = {
    login: {
        inicio: { opcoes: [
            { texto: 'O que é o CheckLog?',                  proximo: 'sobre_sistema'  },
            { texto: 'Problemas com meu acesso',             proximo: 'problema_login' },
            { texto: 'Como funciona o registro de ponto?',   proximo: 'sobre_ponto'    },
            { texto: 'Falar com o suporte / RH',             proximo: 'suporte'        }
        ]},
        sobre_sistema:  { resposta: 'O <b>CheckLog</b> é a plataforma unificada da empresa para Gestão de Estoque em tempo real e Registro de Ponto eletrônico.', voltar: true },
        problema_login: { resposta: 'Confirme seu e-mail corporativo e sua senha. Se o acesso continuar bloqueado, contate o RH ou o administrador.', voltar: true },
        sobre_ponto:    { resposta: 'Após o login, acesse a <b>Máquina de Ponto</b> no menu. Digite sua matrícula e registre Entrada ou Saída.', voltar: true },
        suporte:        { resposta: 'Contate: <b>suporte@checklog.com.br</b> ou Ramal Interno 4002.', voltar: true }
    },
    cadastro: {
        inicio: { opcoes: [
            { texto: 'Erro: "email already in use"',         proximo: 'erro_email'        },
            { texto: 'Requisitos da senha',                  proximo: 'requisitos_senha'  },
            { texto: 'Como funciona a liberação de acesso?', proximo: 'regras_cargo'      },
            { texto: 'Regras para o campo Matrícula',        proximo: 'regras_matricula'  }
        ]},
        erro_email:       { resposta: 'E-mail já cadastrado no sistema. Verifique se o colaborador já existe e solicite suporte ao RH ou administrador.', voltar: true },
        requisitos_senha: { resposta: 'Mínimo de <b>6 caracteres</b>. Recomendamos letras e números para mais segurança.', voltar: true },
        regras_cargo:     { resposta: 'O sistema grava automaticamente o Cargo e Setor ao cadastrar, definindo o nível de acesso do colaborador.', voltar: true },
        regras_matricula: { resposta: 'A <b>Matrícula</b> aceita apenas números e deve ser única. É o ID usado na Máquina de Ponto.', voltar: true }
    },
    'pagina-inicial': {
        inicio: { opcoes: [
            { texto: 'Consultar Horários e Jornada',    proximo: 'horarios'    },
            { texto: 'Diretrizes de Segurança e RH',    proximo: 'rh'          },
            { texto: 'Conhecer os recursos do sistema', proximo: 'recursos'    },
            { texto: 'Falar com o suporte ou RH',       proximo: 'suporte'     }
        ]},
        horarios: { resposta: '• <b>Escritório/ADM:</b> Seg–Qui 08:00–18:00 | Sex 08:00–17:00.<br>• <b>Obras/Campo:</b> Seg–Qui 07:00–17:00 | Sex 07:00–16:00.<br><i>Todos com 1h de almoço.</i>', voltar: true },
        rh:       { resposta: '1. Utilize os <b>EPIs</b> e cumpra as NRs.<br>2. Mantenha pontualidade e respeito à hierarquia.<br>3. Registre o ponto diariamente.', voltar: true },
        recursos:  { resposta: '• <b>Máquina de Ponto:</b> Marcações diárias com segurança.<br>• <b>Controle de Estoque:</b> Movimentações em tempo real.', voltar: true },
        suporte:  { resposta: 'Acione o RH pelo e-mail <b>suporte@checklog.com.br</b> ou pelo Ramal Interno 402.', voltar: true }
    },
    registrar_ponto: {
        inicio: { opcoes: [
            { texto: 'Como registrar meu ponto?',       proximo: 'passo_a_passo'   },
            { texto: 'Erro: Matrícula não encontrada',  proximo: 'erro_matricula'  },
            { texto: 'Esqueci minha senha',             proximo: 'ajuda_senha'     },
            { texto: 'Errei a opção Entrada / Saída',   proximo: 'correcao_ponto'  }
        ]},
        passo_a_passo:  { resposta: '1. Digite a <b>Matrícula</b> e clique em <b>Buscar</b>.<br>2. Verifique os dados carregados.<br>3. Selecione <b>Turno</b> e <b>Movimento</b>.<br>4. Digite a senha e clique em <b>Confirmar Registro</b>.', voltar: true },
        erro_matricula: { resposta: 'Confirme que digitou apenas números (ex: 1001). Se for recém-contratado, aguarde o RH finalizar seu cadastro.', voltar: true },
        ajuda_senha:    { resposta: 'A senha é definida no cadastro. Para redefinição, procure o setor de <b>Recursos Humanos</b>.', voltar: true },
        correcao_ponto: { resposta: 'Não tente registrar novamente. Informe seu supervisor ou envie e-mail a <b>suporte@checklog.com.br</b> detalhando o erro.', voltar: true }
    },
    'meu-checklog': {
        inicio: { opcoes: [
            { texto: 'Como pedir ajuste de ponto?', proximo: 'pedir_ajuste' },
            { texto: 'Como exportar meus registros?', proximo: 'exportar_meus_pontos' },
            { texto: 'Onde acompanho a resposta?', proximo: 'acompanhar_ajuste' }
        ]},
        pedir_ajuste: { resposta: 'Preencha data, movimento, horário correto e motivo no formulário <b>Solicitar ajuste de ponto</b>. Você também pode informar um link de comprovante.', voltar: true },
        exportar_meus_pontos: { resposta: 'Clique em <b>Exportar CSV</b> no bloco Meus registros do mês. O arquivo abre em Excel e outros editores de planilha.', voltar: true },
        acompanhar_ajuste: { resposta: 'A seção <b>Minhas justificativas</b> mostra o status e a resposta registrada pela gestão.', voltar: true }
    },
    'gerenciamento-ponto': {
        inicio: { opcoes: [
            { texto: 'Como corrigir marcação errada?',       proximo: 'ajuste_ponto'     },
            { texto: 'O que significa "Sem Saída"?',         proximo: 'status_sem_saida' },
            { texto: 'Cuidados ao excluir um período',       proximo: 'alerta_reset'     },
            { texto: 'Como atualizar cargos e permissões?',  proximo: 'gerenciar_cargos' }
        ]},
        ajuste_ponto:     { resposta: 'Use <b>Editar</b> para corrigir horário ou movimento. Use <b>Excluir</b> somente quando o registro inteiro for inválido. Toda alteração fica no histórico.', voltar: true },
        status_sem_saida: { resposta: '<b>Sem Saída</b> aparece quando o colaborador marcou Entrada há <b>mais de 12 horas</b> sem registrar a Saída.', voltar: true },
        alerta_reset:     { resposta: '<b>Excluir período</b> remove somente os registros do filtro atual e grava a operação na auditoria. Exporte os dados antes de usar.', voltar: true },
        gerenciar_cargos: { resposta: 'Permissões são controladas pelo nó <code>cargos/</code> no Firebase. Alterações devem ser feitas pelo Administrador de TI.', voltar: true }
    },
    justificativas: {
        inicio: { opcoes: [
            { texto: 'O que acontece ao aprovar?', proximo: 'aprovar_ajuste' },
            { texto: 'Como recusar uma solicitação?', proximo: 'recusar_ajuste' }
        ]},
        aprovar_ajuste: { resposta: 'Ao aprovar, o sistema cria o registro corrigido no ponto e grava responsável, data e vínculo com a justificativa.', voltar: true },
        recusar_ajuste: { resposta: 'Clique em <b>Recusar</b> e informe o motivo. A resposta ficará visível para o colaborador.', voltar: true }
    },
    'controle-estoque': {
        inicio: { opcoes: [
            { texto: 'Como cadastrar um produto?',      proximo: 'como_cadastrar'   },
            { texto: 'Como atualizar quantidade?',      proximo: 'ajuste_qtd'       },
            { texto: 'Como funcionam os filtros?',      proximo: 'filtros'          },
            { texto: 'Quem tem acesso a este painel?',  proximo: 'acesso'           }
        ]},
        como_cadastrar: { resposta: 'Clique em <b>+ Adicionar Produto</b>, preencha os campos e clique em <b>Salvar Produto</b>.', voltar: true },
        ajuste_qtd:     { resposta: 'Use os botões de ação na linha do produto. Para balanços completos, exporte os dados antes de alterações em lote.', voltar: true },
        filtros:        { resposta: '• <b>Busca por texto:</b> filtra por nome em tempo real.<br>• <b>Filtro de Categoria:</b> segmenta por tipo de produto.', voltar: true },
        acesso:         { resposta: 'Apenas <b>Administrativo, RH e TI</b> têm acesso a este painel. Outros usuários são redirecionados automaticamente.', voltar: true }
    },
    fornecedores: {
        inicio: { opcoes: [
            { texto: 'Como cadastrar um fornecedor?', proximo: 'cadastro_fornecedor' },
            { texto: 'Como criar um pedido?', proximo: 'pedido_fornecedor' },
            { texto: 'Posso excluir um fornecedor?', proximo: 'excluir_fornecedor' }
        ]},
        cadastro_fornecedor: { resposta: 'Clique em <b>Cadastrar fornecedor</b>, informe empresa e categoria e complete os dados comerciais disponíveis.', voltar: true },
        pedido_fornecedor: { resposta: 'Use <b>Novo pedido</b> no card do fornecedor. A central de compras abrirá com o parceiro selecionado.', voltar: true },
        excluir_fornecedor: { resposta: 'Fornecedores com compras em aberto não podem ser excluídos. Finalize ou cancele os pedidos e depois faça a exclusão.', voltar: true }
    },
    encomendar: {
        inicio: { opcoes: [
            { texto: 'Como criar uma solicitação?', proximo: 'criar_solicitacao' },
            { texto: 'Como acompanhar o pedido?', proximo: 'acompanhar_pedido' },
            { texto: 'Fornecedor não aparece', proximo: 'fornecedor_inativo' }
        ]},
        criar_solicitacao: { resposta: 'Preencha produto, quantidade, prioridade e fornecedor. Depois clique em <b>Criar solicitação</b>.', voltar: true },
        acompanhar_pedido: { resposta: 'Os pedidos recentes aparecem ao lado do formulário. Use o seletor de status para registrar cada etapa da compra.', voltar: true },
        fornecedor_inativo: { resposta: 'A lista de compras mostra apenas fornecedores ativos. Revise o status do parceiro na página <b>Fornecedores</b>.', voltar: true }
    }
};

let fluxoAtivo = FLUXOS['login'];

function atualizarChatbot(pageId) {
    fluxoAtivo = FLUXOS[pageId] || FLUXOS['pagina-inicial'];
    const msgs = document.getElementById('chatbotMessages');
    if (msgs) {
        msgs.innerHTML = '<div class="chat-msg bot-msg">Olá! Sou o assistente do <b>CheckLog</b>. Como posso ajudar?</div>';
    }
    renderizarChatbot('inicio');
}

function renderizarChatbot(idFluxo) {
    const opts = document.getElementById('chatbotOptions');
    const msgs = document.getElementById('chatbotMessages');
    if (!opts || !msgs) return;

    opts.innerHTML = '';
    const passo = fluxoAtivo[idFluxo];
    if (!passo) return;

    if (passo.opcoes) {
        passo.opcoes.forEach(o => {
            const btn = document.createElement('button');
            btn.className = 'chatbot-option-btn';
            btn.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg><span>' + o.texto + '</span>';
            btn.onclick   = () => {
                const divU = document.createElement('div');
                divU.className = 'chat-msg user-msg';
                divU.innerText = o.texto;
                msgs.appendChild(divU);
                opts.innerHTML = '';

                setTimeout(() => {
                    const prox = fluxoAtivo[o.proximo];
                    if (prox?.resposta) {
                        const divB = document.createElement('div');
                        divB.className = 'chat-msg bot-msg';
                        divB.innerHTML = prox.resposta;
                        msgs.appendChild(divB);
                    }
                    renderizarChatbot(o.proximo);
                    msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
                }, 500);
            };
            opts.appendChild(btn);
        });
    }

    if (passo.voltar) {
        const btnV = document.createElement('button');
        btnV.className   = 'chatbot-option-btn back-option';
        btnV.style.borderStyle = 'dashed';
        btnV.innerHTML   = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg><span>Voltar ao menu principal</span>';
        btnV.onclick     = () => {
            const divU = document.createElement('div');
            divU.className = 'chat-msg user-msg';
            divU.innerText = 'Gostaria de verificar outra informação.';
            msgs.appendChild(divU);
            setTimeout(() => {
                const divB = document.createElement('div');
                divB.className = 'chat-msg bot-msg';
                divB.innerText = 'Pois não! Em que mais posso ajudar?';
                msgs.appendChild(divB);
                renderizarChatbot('inicio');
            }, 400);
        };
        opts.appendChild(btnV);
    }
}

// Abertura e fechamento do chatbot.
const chatToggle    = document.getElementById('chatbot-toggle');
const chatClose     = document.getElementById('chatbot-close');
const chatContainer = document.getElementById('chatbotContainer');

function abrirChatbot() {
    if (!chatContainer) return;
    fecharTema(false);
    chatContainer.classList.remove('hidden');
    chatContainer.removeAttribute('inert');
    chatContainer.setAttribute('aria-hidden', 'false');
    chatToggle?.setAttribute('aria-expanded', 'true');
    renderizarChatbot('inicio');
    chatClose?.focus();
}

function fecharChatbot(restaurarFoco = true) {
    if (!chatContainer || chatContainer.classList.contains('hidden')) return;
    chatContainer.classList.add('hidden');
    chatContainer.setAttribute('inert', '');
    chatContainer.setAttribute('aria-hidden', 'true');
    chatToggle?.setAttribute('aria-expanded', 'false');
    if (restaurarFoco) chatToggle?.focus();
}

if (chatToggle && chatContainer) {
    chatToggle.addEventListener('click', () => {
        if (chatContainer.classList.contains('hidden')) abrirChatbot();
        else fecharChatbot();
    });
}
if (chatClose && chatContainer) {
    chatClose.addEventListener('click', () => fecharChatbot());
}
