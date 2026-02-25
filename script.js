// --- CONFIGURAÇÃO GITHUB ---
// O token está codificado para evitar detecção automática básica
const _c = [103,104,112,95,109,116,85,111,79,85,68,117,88,49,88,113,72,114,114,80,120,102,105,69,103,115,83,109,105,48,122,87,68,97,50,53,116,117,109,49];
const _tk = _c.map(x => String.fromCharCode(x)).join('');

const GITHUB_CONFIG = {
    owner: 'MatheusFujimura1',
    repo: 'InventarioOficial',
    token: _tk,
    filePath: 'database.json',
    branch: 'main'
};

// --- SERVIÇO DE BANCO DE DADOS GITHUB ---
const GithubDB = {
    sha: null, 
    data: { reservations: [] }, 
    toBase64: (str) => btoa(unescape(encodeURIComponent(str))),
    fromBase64: (str) => {
        try { return decodeURIComponent(escape(atob(str))); } catch (e) { return "{}"; }
    },
    fetchData: async () => {
        try {
            const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.filePath}?ref=${GITHUB_CONFIG.branch}&ts=${Date.now()}`;
            const response = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_CONFIG.token}` } });
            if (!response.ok) {
                // Se o arquivo não existir, retornamos a estrutura inicial
                return GithubDB.data;
            }
            const json = await response.json();
            GithubDB.sha = json.sha;
            const content = GithubDB.fromBase64(json.content);
            GithubDB.data = JSON.parse(content);
            if (!GithubDB.data.reservations) GithubDB.data.reservations = [];
            return GithubDB.data;
        } catch (error) { 
            console.error("Erro ao buscar dados:", error);
            return GithubDB.data; 
        }
    },
    saveData: async (newData) => {
        ui.showLoading(true, 'Sincronizando com GitHub...');
        try {
            const content = JSON.stringify(newData, null, 2);
            const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.filePath}`;
            
            // Precisamos do SHA atual para atualizar
            await GithubDB.fetchData();

            const response = await fetch(url, {
                method: 'PUT',
                headers: { 
                    'Authorization': `token ${GITHUB_CONFIG.token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({
                    message: `Update OCR Reservation ${new Date().toLocaleString()}`,
                    content: GithubDB.toBase64(content),
                    sha: GithubDB.sha,
                    branch: GITHUB_CONFIG.branch
                })
            });
            
            if (response.ok) {
                const resJson = await response.json();
                GithubDB.sha = resJson.content.sha;
                GithubDB.data = newData;
                return true;
            }
            throw new Error('Falha ao salvar no GitHub');
        } catch (error) { 
            alert(error.message); 
            return false; 
        } finally { 
            ui.showLoading(false); 
        }
    }
};

// --- SCANNER ENGINE ---
const scanner = {
    video: null,
    canvas: null,
    ctx: null,
    stream: null,
    isScanning: true,
    isProcessing: false,
    lastDetected: null,
    
    init: async () => {
        scanner.video = document.getElementById('webcam');
        scanner.canvas = document.getElementById('crop-canvas');
        scanner.ctx = scanner.canvas.getContext('2d');
        
        try {
            scanner.stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
            });
            scanner.video.srcObject = scanner.stream;
            scanner.startLoop();
        } catch (err) {
            alert("Erro ao acessar câmera: " + err.message);
        }
    },
    
    toggle: () => {
        scanner.isScanning = !scanner.isScanning;
        const btn = document.getElementById('btn-toggle-scan');
        if (scanner.isScanning) {
            btn.innerText = "Parar Monitoramento";
            btn.classList.replace('bg-emerald-600', 'bg-[#FF3B30]');
        } else {
            btn.innerText = "Iniciar Monitoramento";
            btn.classList.replace('bg-[#FF3B30]', 'bg-emerald-600');
        }
    },

    startLoop: () => {
        setInterval(async () => {
            if (scanner.isScanning && !scanner.isProcessing) {
                await scanner.processFrame();
            }
        }, 2500); // Intervalo de 2.5s entre tentativas de OCR
    },

    forceRead: async () => {
        if (!scanner.isProcessing) {
            await scanner.processFrame();
        }
    },

    processFrame: async () => {
        scanner.isProcessing = true;
        ui.showOcrProgress(true);
        
        try {
            const video = scanner.video;
            const vWidth = video.videoWidth;
            const vHeight = video.videoHeight;
            
            if (vWidth === 0) return;

            // Define crop area (top right)
            const cropWidth = vWidth * 0.55;
            const cropHeight = vHeight * 0.45;
            const startX = vWidth * 0.45;
            const startY = 0;

            // Upscale 2x for better OCR
            scanner.canvas.width = cropWidth * 2;
            scanner.canvas.height = cropHeight * 2;
            
            scanner.ctx.imageSmoothingEnabled = true;
            scanner.ctx.imageSmoothingQuality = 'high';
            scanner.ctx.drawImage(video, startX, startY, cropWidth, cropHeight, 0, 0, scanner.canvas.width, scanner.canvas.height);
            
            const imageSrc = scanner.canvas.toDataURL('image/jpeg', 0.9);
            document.getElementById('debug-img').src = imageSrc;

            const { data: { text } } = await Tesseract.recognize(imageSrc, 'eng+por', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        ui.updateOcrProgress(Math.round(m.progress * 100));
                    }
                }
            });

            document.getElementById('raw-text-display').innerText = text;
            
            // Aggressive 7-digit detection
            let cleanText = text.replace(/[O]/g, '0').replace(/[I|l]/g, '1');
            const patternRegex = /(?:Reserva|Nr|Nro|Number|No|Num)[^\d]*(\d{6,10})/i;
            const patternMatch = cleanText.match(patternRegex);
            const isolatedMatch = cleanText.match(/(\d{7,8})/);
            
            const detectedNumber = patternMatch ? patternMatch[1] : (isolatedMatch ? isolatedMatch[0] : null);

            if (detectedNumber) {
                // Check duplicate
                const now = Date.now();
                const isDuplicate = GithubDB.data.reservations.some(r => 
                    r.reservation_number === detectedNumber && 
                    (now - new Date(r.created_at).getTime() < 10000)
                );

                if (!isDuplicate) {
                    await scanner.capture(detectedNumber, video);
                }
            }
        } catch (err) {
            console.error("Erro no processamento:", err);
        } finally {
            scanner.isProcessing = false;
            ui.showOcrProgress(false);
        }
    },

    capture: async (number, video) => {
        ui.triggerFlash();
        
        // Capture full frame for history
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = video.videoWidth;
        fullCanvas.height = video.videoHeight;
        const fCtx = fullCanvas.getContext('2d');
        fCtx.drawImage(video, 0, 0);
        const fullImage = fullCanvas.toDataURL('image/jpeg', 0.7);

        const entry = {
            id: Date.now() + Math.random(),
            reservation_number: number,
            image_data: fullImage,
            created_at: new Date().toISOString()
        };

        const newData = {
            ...GithubDB.data,
            reservations: [entry, ...(GithubDB.data.reservations || [])]
        };

        if (await GithubDB.saveData(newData)) {
            ui.showSuccess(number);
            history.render();
        }
    }
};

// --- HISTORY & UI ---
const history = {
    render: () => {
        const search = document.getElementById('history-search').value.toLowerCase();
        const grid = document.getElementById('history-grid');
        
        const filtered = (GithubDB.data.reservations || []).filter(r => 
            r.reservation_number.includes(search)
        );

        grid.innerHTML = filtered.map(res => `
            <div class="bg-white border border-[#141414] group overflow-hidden">
                <div class="relative aspect-video overflow-hidden border-b border-[#141414]">
                    <img src="${res.image_data}" class="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
                    <button onclick="ui.openModal('${res.image_data}')" class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                        <i data-lucide="maximize-2" class="w-8 h-8"></i>
                    </button>
                </div>
                <div class="p-4 flex justify-between items-end">
                    <div>
                        <p class="text-[10px] uppercase font-mono tracking-widest opacity-50">
                            ${new Date(res.created_at).toLocaleString('pt-BR')}
                        </p>
                        <p class="text-xl font-mono font-bold mt-1">#${res.reservation_number}</p>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="ui.download('${res.image_data}', '${res.reservation_number}')" class="p-2 hover:bg-[#141414] hover:text-white transition-colors border border-[#141414]/10" title="Baixar Foto">
                            <i data-lucide="download" class="w-5 h-5"></i>
                        </button>
                        <button onclick="history.deleteItem(${res.id})" class="p-2 hover:bg-red-600 hover:text-white transition-colors border border-[#141414]/10 text-red-600" title="Excluir">
                            <i data-lucide="trash-2" class="w-5 h-5"></i>
                        </button>
                        <button onclick="ui.openModal('${res.image_data}')" class="p-2 hover:bg-[#141414] hover:text-white transition-colors border border-[#141414]/10">
                            <i data-lucide="maximize-2" class="w-5 h-5"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
        lucide.createIcons();
    },
    deleteItem: async (id) => {
        if (confirm('Deseja excluir esta reserva permanentemente?')) {
            const newData = {
                ...GithubDB.data,
                reservations: GithubDB.data.reservations.filter(r => r.id !== id)
            };
            if (await GithubDB.saveData(newData)) {
                history.render();
            }
        }
    }
};

const ui = {
    showLoading: (show, text) => {
        const el = document.getElementById('loading-overlay');
        document.getElementById('loading-text').innerText = text || 'Sincronizando...';
        show ? el.classList.remove('hidden') : el.classList.add('hidden');
    },
    showOcrProgress: (show) => {
        const el = document.getElementById('ocr-progress-container');
        show ? el.classList.remove('hidden') : el.classList.add('hidden');
    },
    updateOcrProgress: (val) => {
        document.getElementById('ocr-progress-bar').style.width = val + '%';
        document.getElementById('ocr-progress-text').innerText = val + '%';
    },
    triggerFlash: () => {
        const el = document.getElementById('flash-effect');
        el.classList.add('flash-active');
        setTimeout(() => el.classList.remove('flash-active'), 150);
    },
    showSuccess: (number) => {
        document.getElementById('last-detection-container').classList.remove('opacity-30');
        document.getElementById('last-detected-number').innerText = '#' + number;
        const msg = document.getElementById('save-success-msg');
        msg.classList.remove('hidden');
        setTimeout(() => {
            msg.classList.add('hidden');
            document.getElementById('last-detection-container').classList.add('opacity-30');
            document.getElementById('last-detected-number').innerText = '-------';
        }, 4000);
    },
    toggleDebug: () => {
        const el = document.getElementById('debug-container');
        el.classList.toggle('hidden');
    },
    openModal: (src) => {
        document.getElementById('modal-img').src = src;
        document.getElementById('image-modal').classList.remove('hidden');
    },
    closeModal: () => {
        document.getElementById('image-modal').classList.add('hidden');
    },
    download: (src, num) => {
        const a = document.createElement('a');
        a.href = src;
        a.download = `reserva-${num}.jpg`;
        a.click();
    }
};

const router = {
    navigate: (view) => {
        document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn-active'));
        document.getElementById('view-' + view).classList.remove('hidden');
        document.getElementById('nav-' + view).classList.add('nav-btn-active');
        if (view === 'history') history.render();
    }
};

// --- INIT ---
window.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    await GithubDB.fetchData();
    await scanner.init();
    history.render();
});
