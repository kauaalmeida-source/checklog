const STOCK_AR_STATUS = Object.freeze({
    critical: {
        kind: 'critical',
        label: 'Crítico',
        tone: 'danger',
        recommendation: 'Priorize reposição ou valide se há pedido em aberto.'
    },
    attention: {
        kind: 'attention',
        label: 'Atenção',
        tone: 'warning',
        recommendation: 'Acompanhe o consumo e programe reposição se a demanda continuar.'
    },
    normal: {
        kind: 'normal',
        label: 'Normal',
        tone: 'success',
        recommendation: 'Saldo confortável para a rotina atual.'
    }
});

const FALLBACK_MESSAGES = Object.freeze({
    'insecure-context': 'Use HTTPS ou localhost para testar a câmera. Exibindo prévia do item.',
    'permission-denied': 'Permissão da câmera negada. Exibindo prévia do item.',
    unsupported: 'Câmera indisponível neste navegador. Exibindo prévia do item.',
    unknown: 'Não foi possível iniciar a câmera. Exibindo prévia do item.'
});

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function toStockInteger(value) {
    return Math.max(0, Math.trunc(toFiniteNumber(value)));
}

function formatBRL(value) {
    return toFiniteNumber(value).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).replace(/[\u00A0\u202F]/g, ' ');
}

export function getStockArStatus(product = {}) {
    const quantity = toStockInteger(product.qty);
    const minimum = toStockInteger(product.minQty);

    if (quantity <= minimum) return STOCK_AR_STATUS.critical;
    if (quantity <= minimum * 1.5) return STOCK_AR_STATUS.attention;
    return STOCK_AR_STATUS.normal;
}

export function buildStockArViewModel(product = {}) {
    const quantity = toStockInteger(product.qty);
    const minimum = toStockInteger(product.minQty);
    const cost = toFiniteNumber(product.price);
    const sale = toFiniteNumber(product.salePrice);
    const margin = sale - cost;
    const status = getStockArStatus({ qty: quantity, minQty: minimum });
    const category = String(product.category || '').trim() || 'Sem categoria';

    return {
        id: String(product.key || product.id || ''),
        name: String(product.name || '').trim() || 'Produto sem nome',
        category,
        quantity,
        minimum,
        cost,
        sale,
        margin,
        quantityLabel: `${quantity} un.`,
        minimumLabel: `${minimum} un.`,
        costLabel: formatBRL(cost),
        saleLabel: formatBRL(sale),
        marginLabel: formatBRL(margin),
        status,
        recommendation: status.recommendation,
        summary: `${category} · ${quantity} un. em estoque · mínimo ${minimum} un.`
    };
}

export function getCameraUnavailableMessage(reason = 'unknown') {
    return FALLBACK_MESSAGES[reason] || FALLBACK_MESSAGES.unknown;
}

export function detectCameraSupport(environment = globalThis) {
    if (!environment.isSecureContext) {
        return { supported: false, reason: 'insecure-context' };
    }

    const getUserMedia = environment.navigator?.mediaDevices?.getUserMedia;
    if (typeof getUserMedia !== 'function') {
        return { supported: false, reason: 'unsupported' };
    }

    return { supported: true, reason: '' };
}

function mapCameraError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'permission-denied';
    if (error?.name === 'NotFoundError' || error?.name === 'NotReadableError') return 'unsupported';
    return 'unknown';
}

export function createStockArCameraController({ videoElement, mediaDevices }) {
    let activeStream = null;

    return {
        async start() {
            if (!videoElement || typeof mediaDevices?.getUserMedia !== 'function') {
                return { ok: false, reason: 'unsupported' };
            }

            try {
                activeStream = await mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' } },
                    audio: false
                });
                videoElement.srcObject = activeStream;
                if (typeof videoElement.play === 'function') {
                    await videoElement.play();
                }
                return { ok: true, reason: '' };
            } catch (error) {
                if (activeStream?.getTracks) {
                    activeStream.getTracks().forEach(track => track.stop());
                }
                activeStream = null;
                if (videoElement) videoElement.srcObject = null;
                return { ok: false, reason: mapCameraError(error) };
            }
        },

        stop() {
            if (activeStream?.getTracks) {
                activeStream.getTracks().forEach(track => track.stop());
            }
            activeStream = null;
            if (videoElement) videoElement.srcObject = null;
        }
    };
}
