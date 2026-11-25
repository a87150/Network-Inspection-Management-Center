/* AI 助手：单用户单会话问答 + 「配置 API」「添加知识库条目」两个 Bootstrap 弹窗。
   历史/提问/清空/配置/知识库全走 /api/ai/ REST；X-CSRFToken 由 api.mjs 负责。 */
import { api, csrfToken } from '../api.mjs';

/* 配置回填：api_key 永远留空——只存密文，不回显。 */
function settingsFields(source) {
    const payload = source || {};
    return {
        base_url: payload.base_url || '',
        api_key: '',
        chat_model: payload.chat_model || '',
        embed_model: payload.embed_model || '',
        rag_backend: ['hybrid', 'vector', 'keyword'].includes(payload.rag_backend) ? payload.rag_backend : 'hybrid',
                max_history: payload.max_history ?? 10,
                summary_trigger: payload.summary_trigger ?? 20,
                reasoning_effort: payload.reasoning_effort || '',
                models_text: payload.models_text || '',
        retrieval_max_distance: numberText(payload.retrieval_max_distance),
        keyword_max_distance: numberText(payload.keyword_max_distance),
    };
}

function numberText(value) {
    return typeof value === 'number' ? String(value) : '';
}

export default {
    delimiters: ['[[', ']]'],
    props: {
        // 由 ai_assistant/views.py 的 ai_bootstrap 注水；URL 默认值与 urls.py 一致。
        page: {type: Object, default: () => ({})},
        settings: {type: Object, default: () => ({})},
        is_admin: {type: Boolean, default: false},
        chat_url: {type: String, default: '/api/ai/chat/'},
        history_url: {type: String, default: '/api/ai/history/'},
        reset_url: {type: String, default: '/api/ai/reset/'},
        settings_url: {type: String, default: '/api/ai/settings/'},
        settings_save_url: {type: String, default: '/api/ai/settings/save/'},
        knowledge_url: {type: String, default: '/api/ai/knowledge/'},
        knowledge_add_url: {type: String, default: '/api/ai/knowledge/add/'},
        knowledge_import_url: {type: String, default: '/api/ai/knowledge/import/'},
    },
    data() {
        return {
        // 与后端 CATEGORY_CHOICES 一致；改这里要同步改 views.py。
        categories: ['设备手册', '故障案例', '模板说明', '告警规则', '巡检规范', '其他'],
            messages: [],
            usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, tokens_per_second: 0},
            draft: '',
            loading: false,
            sending: false,
            resetting: false,
            // 清空会删历史，点一次只是待确认，点第二次才真发请求。
            confirmReset: false,
            error: '',
            // 弹窗关掉后仍要看到的提示。
            pageMessage: '',
            flashTimer: 0,
            settingsForm: settingsFields(this.settings),
            hasApiKey: Boolean(this.settings && this.settings.has_api_key),
            settingsLoading: false,
            settingsSaving: false,
            settingsError: '',
            knowledge: {total: 0, embedded: 0},
            knowledgeLoading: false,
            knowledgeError: '',
            knowledgeForm: {title: '', category: '', content: ''},
        // 内置提供方：选中就自动填地址，省得每次手打。
        presets: [
            {name: 'DeepSeek', url: 'https://api.deepseek.com/v1'},
            {name: 'OpenAI', url: 'https://api.openai.com/v1'},
            {name: '阿里百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1'},
            {name: '本地 Ollama', url: 'http://127.0.0.1:11434/v1'},
        ],
        preset: '',
        providers: [],
        probeQuery: '',
        probing: false,
        probeDone: false,
        probeError: '',
        probeHits: [],
            adding: false,
            addError: '',
            addMessage: '',
            importFile: null,
            importPreview: '',
            importName: '',
            importing: false,
            importError: '',
            importMessage: '',
            importSkipped: [],
        };
    },
    computed: {
        activeProviderId() {
            const current = this.providers.find((row) => row.is_active);
            return current ? current.id : '';
        },
        modelOptions() {
            // 优先用设置里填的可用模型；没填就退回当前这一个。
            const typed = (this.settingsForm.models_text || '')
                .split(/[,\n，]/)
                .map((line) => line.trim())
                .filter(Boolean);
            const list = typed.length ? typed : (this.settingsForm.chat_model ? [this.settingsForm.chat_model] : []);
            const current = this.settingsForm.chat_model;
            return current && !list.includes(current) ? [current].concat(list) : list;
        },
        canSend() {
            return this.draft.trim().length > 0 && !this.sending;
        },
    },
    mounted() {
        this.loadHistory();
        // 输入区的模型下拉需要当前值，进页面先拉一次设置（只读，不打知识库）。
        this.loadSettings({ silent: true });
        this.loadProviders();
        // 打开弹窗才拉配置与知识库现状：进页面不多打两个请求。
        const settingsModal = this.$refs.settingsModal;
        if (settingsModal) settingsModal.addEventListener('show.bs.modal', () => this.loadSettings());
        const knowledgeModal = this.$refs.knowledgeModal;
        if (knowledgeModal) knowledgeModal.addEventListener('show.bs.modal', () => this.loadKnowledge());
    },
    methods: {
        fmtTokens(value) {
            const number = Number(value) || 0;
            if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M';
            if (number >= 1000) return (number / 1000).toFixed(1) + 'k';
            return String(number);
        },
        sourceLabel(source) {
            // 混合检索下不给距离：向量距离和关键词得分量纲不同，
            // 混在一个列表里显示会让人以为能横向比较。via 说明命中方式。
            const map = {vector: '语义命中', keyword: '字面命中', both: '两路命中'};
            const mark = map[source.via];
            return mark ? source.title + ' · ' + mark : source.title;
        },
        describe(failure, fallback) {
            if (failure && failure.status === 403) return '当前账号没有这个操作权限（403）。';
            return (failure && failure.message) || fallback;
        },
        flash(message) {
            this.pageMessage = message;
            window.clearTimeout(this.flashTimer);
            this.flashTimer = window.setTimeout(() => {
                this.pageMessage = '';
            }, 6000);
        },
        closeModal(name) {
            const element = this.$refs[name];
            if (!element || !window.bootstrap) return;
            window.bootstrap.Modal.getOrCreateInstance(element).hide();
        },
        async loadHistory() {
            this.loading = true;
            this.error = '';
            try {
                const payload = await api.get(this.history_url);
                this.messages = (payload && payload.messages) || [];
                this.usage = (payload && payload.usage) || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, tokens_per_second: 0};
                this.scrollToLatest();
            } catch (failure) {
                this.error = failure.message || '历史消息加载失败';
            } finally {
                this.loading = false;
            }
        },
        async send() {
            const message = this.draft.trim();
            if (!message || this.sending) return;
            this.sending = true;
            this.confirmReset = false;
            this.error = '';
            // 先挂本地气泡，等服务端回来再补回答；失败就撤掉并还原草稿。
            this.messages.push({role: 'user', content: message, blocked: false, sources: []});
            this.draft = '';
            this.scrollToLatest();
            try {
                const payload = await api.post(this.chat_url, {message});
                this.messages.push({
                    role: 'assistant',
                    content: payload.answer,
                    blocked: Boolean(payload.blocked),
                    sources: payload.sources || [],
                });
            } catch (failure) {
                this.messages.pop();
                this.draft = message;
                this.error = failure.message || '发送失败，请稍后重试';
            } finally {
                this.sending = false;
                this.scrollToLatest();
                this.focusInput();
            }
        },
        requestReset() {
            if (this.resetting || this.sending) return;
            if (!this.confirmReset) {
                this.confirmReset = true;
                return;
            }
            this.performReset();
        },
        async performReset() {
            this.resetting = true;
            this.error = '';
            try {
                await api.post(this.reset_url, {});
                this.messages = [];
            } catch (failure) {
                this.error = failure.message || '清空失败，请稍后重试';
            } finally {
                this.resetting = false;
                this.confirmReset = false;
                this.focusInput();
            }
        },
        async loadSettings(options) {
            this.loadProviders();
            const silent = Boolean(options && options.silent);
            if (!silent) this.settingsLoading = true;
            this.settingsError = '';
            try {
                const payload = await api.get(this.settings_url);
                this.settingsForm = settingsFields(payload);
                this.hasApiKey = Boolean(payload && payload.has_api_key);
            } catch (failure) {
                this.settingsError = this.describe(failure, '读取配置失败，请稍后重试。');
            } finally {
                if (!silent) this.settingsLoading = false;
            }
        },
        async saveSettings() {
            if (this.settingsSaving) return;
            this.settingsSaving = true;
            this.settingsError = '';
            try {
                const payload = await api.post(this.settings_save_url, {
                    base_url: this.settingsForm.base_url,
                    api_key: this.settingsForm.api_key,
                    chat_model: this.settingsForm.chat_model,
                    models_text: this.settingsForm.models_text,
                    embed_model: this.settingsForm.embed_model,
                    rag_backend: this.settingsForm.rag_backend,
                    retrieval_max_distance: this.settingsForm.retrieval_max_distance,
                    keyword_max_distance: this.settingsForm.keyword_max_distance,
                });
                this.settingsForm.api_key = '';
                this.hasApiKey = Boolean(payload && payload.has_api_key);
                this.closeModal('settingsModal');
                this.flash('已保存，立即生效');
            } catch (failure) {
                this.settingsError = this.describe(failure, '保存失败，请稍后重试。');
            } finally {
                this.settingsSaving = false;
            }
        },
        async loadKnowledge() {
            this.knowledgeLoading = true;
            this.knowledgeError = '';
            try {
                const payload = await api.get(this.knowledge_url);
                this.knowledge = {
                    total: Number(payload && payload.total) || 0,
                    embedded: Number(payload && payload.embedded) || 0,
                };
            } catch (failure) {
                this.knowledgeError = this.describe(failure, '读取知识库现状失败。');
            } finally {
                this.knowledgeLoading = false;
            }
        },
        async addKnowledge() {
            if (this.adding) return;
            const title = this.knowledgeForm.title.trim();
            const content = this.knowledgeForm.content.trim();
            this.addError = '';
            this.addMessage = '';
            if (!title || !content) {
                this.addError = '标题和内容都要填。';
                return;
            }
            this.adding = true;
            try {
                await api.post(this.knowledge_add_url, {
                    title,
                    content,
                    category: this.knowledgeForm.category.trim(),
                });
                this.knowledgeForm = {title: '', category: '', content: ''};
                this.addMessage = '已添加：' + title;
                this.loadKnowledge();
            } catch (failure) {
                this.addError = this.describe(failure, '保存失败，请稍后重试。');
            } finally {
                this.adding = false;
            }
        },
        /* ponytail: 逐行解析，字段里不支持换行。Excel 多行单元格粘进来会拆成多行，
           真需要时再上完整 CSV 状态机。 */
        splitCells(line) {
            const delimiter = line.includes('\t') ? '\t' : ',';
            const cells = [];
            let cell = '';
            let quoted = false;
            for (let index = 0; index < line.length; index += 1) {
                const char = line[index];
                if (quoted) {
                    if (char !== '"') {
                        cell += char;
                    } else if (line[index + 1] === '"') {
                        cell += '"';
                        index += 1;
                    } else {
                        quoted = false;
                    }
                    continue;
                }
                if (char === '"' && !cell.trim()) {
                    quoted = true;
                    continue;
                }
                if (char === delimiter) {
                    cells.push(cell);
                    cell = '';
                    continue;
                }
                cell += char;
            }
            cells.push(cell);
            return cells;
        },
        applyPreset() {
            const hit = this.presets.find((item) => item.name === this.preset);
            if (hit) this.settingsForm.base_url = hit.url;
        },
        async clearApiKey() {
            try {
                await api.post(this.settings_save_url, {clear_api_key: true});
                this.hasApiKey = false;
                this.settingsForm.api_key = '';
            } catch (error) {
                this.settingsError = error.message || '清除失败';
            }
        },
        async switchProvider(id) {
            if (!id) return;
            try {
                await api.post('/api/ai/providers/activate/', {id});
                await this.loadProviders();
            } catch (error) {
                this.error = error.message || '切换失败';
            }
        },
        async loadProviders() {
            try {
                const payload = await api.get('/api/ai/providers/');
                this.providers = (payload && payload.rows) || [];
            } catch (error) {
                this.providers = [];
            }
        },
        async activateProvider(row) {
            try {
                await api.post('/api/ai/providers/activate/', {id: row.id});
                await this.loadProviders();
                await this.loadSettings({silent: true});
            } catch (error) {
                this.settingsError = error.message || '切换失败';
            }
        },
        async deleteProvider(row) {
            try {
                await api.post('/api/ai/providers/delete/', {id: row.id});
                await this.loadProviders();
                await this.loadSettings({silent: true});
            } catch (error) {
                this.settingsError = error.message || '删除失败';
            }
        },
        async runProbe() {
            const query = this.probeQuery.trim();
            if (!query || this.probing) return;
            this.probing = true;
            this.probeError = '';
            this.probeDone = false;
            this.probeHits = [];
            try {
                const payload = await api.post('/api/ai/retrieve_test/', {query});
                this.probeHits = (payload && payload.hits) || [];
                this.probeDone = true;
            } catch (failure) {
                this.probeError = this.describe(failure, '检索失败，请稍后重试。');
            } finally {
                this.probing = false;
            }
        },
        async persistModelChoice() {
            // 输入框里的两个下拉要立刻生效，不然选了不保存等于没选。
            try {
                await api.post(this.settings_save_url, {
                    chat_model: this.settingsForm.chat_model,
                    reasoning_effort: this.settingsForm.reasoning_effort,
                });
            } catch (error) {
                this.error = error.message || '模型选择保存失败';
            }
        },
        async onFilePicked(event) {
            const file = event.target.files && event.target.files[0];
            this.importError = '';
            this.importResult = null;
            if (!file) {
                this.importFile = null;
                this.importName = '';
                this.importPreview = '';
                return;
            }
            this.importFile = file;
            this.importName = file.name;
            try {
                // 只做预览：解析在服务端也做一遍，这里是为了让用户看到读到了什么。
                this.importPreview = await file.text();
            } catch (error) {
                this.importError = '读不了这个文件：' + error.message;
                this.importPreview = '';
            }
        },
        clearFile() {
            this.importFile = null;
            this.importName = '';
            this.importPreview = '';
            this.importError = '';
            this.importResult = null;
        },
        parseTable(text) {
            const lines = String(text || '')
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .filter((line) => line.trim());
            const cells = lines.map((line) => this.splitCells(line));
            // 首行是表头（title / 标题 开头）就跳过。
            if (cells.length && /^(title|标题)/i.test((cells[0][0] || '').trim())) cells.shift();
            return cells.map((row) => ({
                title: (row[0] || '').trim(),
                content: (row[1] || '').trim(),
                category: (row[2] || '').trim(),
            }));
        },
        async runImport() {
            if (this.importing) return;
            if (!this.importFile) {
                this.importError = '先选一个 CSV 或 TXT 文件。';
                return;
            }
            this.importError = '';
            this.importMessage = '';
            this.importSkipped = [];
            this.importing = true;
            try {
                // 走 multipart：编码由服务端按 utf-8-sig / utf-8 / gb18030 依次试，
                // Excel 在中文 Windows 上导出的 CSV 是 GBK，前端猜编码只会猜错。
                const body = new FormData();
                body.append('file', this.importFile);
                const response = await fetch(this.knowledge_import_url, {
                    method: 'POST',
                    body,
                    credentials: 'same-origin',
                    headers: {'X-CSRFToken': csrfToken()},
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.error || ('导入失败（' + response.status + '）'));
                }
                this.importMessage = '新增 ' + (Number(payload.created) || 0) + ' 条，跳过 '
                    + ((payload.skipped || []).length) + ' 条。';
                this.importSkipped = payload.skipped || [];
                this.clearFile();
                this.loadKnowledge();
            } catch (failure) {
                this.importError = failure.message || '导入失败，请稍后重试。';
            } finally {
                this.importing = false;
            }
        },
        scrollToLatest() {
            this.$nextTick(() => {
                const thread = this.$refs.thread;
                if (thread) thread.scrollTop = thread.scrollHeight;
            });
        },
        focusInput() {
            const input = this.$refs.input;
            if (input && !input.disabled) input.focus();
        },
    },
    template: `
    <div class="ai-chat">
        <p v-if="pageMessage" class="alert alert-success ai-chat__flash" role="status">[[ pageMessage ]]</p>

        <section class="card surface-card ai-chat__panel" aria-labelledby="ai-chat-panel-title">
            <div class="card-body ai-chat__panel-body">
                

                <p v-if="error" class="alert alert-danger ai-chat__error" role="alert">[[ error ]]</p>

                <div ref="thread" class="ai-chat__thread" role="log" aria-live="polite" aria-relevant="additions"
                     aria-label="对话记录" tabindex="0">
                    <p v-if="loading" class="ai-chat__empty">正在读取历史消息…</p>
                    <p v-else-if="!messages.length" class="ai-chat__empty">还没有对话。下面输入一个运维问题开始。</p>
                    <article v-for="(message, index) in messages" :key="index" class="ai-chat__bubble"
                             :class="[message.role === 'user' ? 'ai-chat__bubble--user' : 'ai-chat__bubble--assistant', {'is-blocked': message.blocked}]">
                        <p class="ai-chat__role">
                            <span>[[ message.role === 'user' ? '我' : 'AI 助手' ]]</span>
                            <span v-if="message.blocked" class="ai-chat__flag">已拦截</span>
                        </p>
                        <div class="ai-chat__content">[[ message.content ]]</div>
                        <ul v-if="message.sources && message.sources.length" class="ai-chat__sources" aria-label="参考来源">
                            <li v-for="(source, position) in message.sources" :key="position" class="ai-chat__source"
                                :title="sourceLabel(source)">[[ source.title ]]</li>
                        </ul>
                    </article>
                </div>

                <form class="ai-chat__composer" @submit.prevent="send">
                <label class="visually-hidden" for="ai-chat-input">提问内容</label>
                <textarea id="ai-chat-input" ref="input" class="ai-chat__input" rows="2" v-model="draft"
                          :disabled="sending" autocomplete="off"
                          placeholder="输入运维问题，Enter 发送，Shift+Enter 换行"
                          @keydown.enter.exact.prevent="send"></textarea>
                <div class="ai-chat__composer-bar">
                    <span class="ai-chat__stat">[[ messages.length ]] 条</span>
                    <span class="ai-chat__stat">[[ fmtTokens(usage.total_tokens) ]] tok</span>
                    <span class="ai-chat__stat" v-if="usage.tokens_per_second">[[ usage.tokens_per_second ]] tok/s</span>
                    <span class="ai-chat__stat" v-if="knowledge.total">知识库 [[ knowledge.total ]]</span>
                    <span class="ai-chat__spacer-fill"></span>
                    <select class="ai-chat__pill" :value="activeProviderId" title="切换模型服务"
                            @change="switchProvider($event.target.value)">
                        <option v-if="!providers.length" value="">未配置</option>
                        <option v-for="row in providers" :key="row.id" :value="row.id">
                            [[ row.name ]][[ row.chat_model ? ' · ' + row.chat_model : '' ]]
                        </option>
                    </select>
                    <select class="ai-chat__pill" v-model="settingsForm.reasoning_effort" title="思考模式"
                            @change="persistModelChoice">
                        <option value="">不思考</option>
                        <option value="low">思考 low</option>
                        <option value="medium">思考 medium</option>
                        <option value="high">思考 high</option>
                    </select>
                    <span class="ai-chat__spacer"></span>
                    <button class="ai-chat__send" type="submit" :disabled="!canSend">
                        [[ sending ? '…' : '发送' ]]
                    </button>
                </div>
            </form>
            </div>
        </section>

        <div v-if="is_admin" class="modal fade" id="aiSettingsModal" ref="settingsModal" tabindex="-1"
             aria-labelledby="aiSettingsModalLabel" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable modal-shell">
                <div class="modal-content modal-surface">
                    <div class="modal-header">
                        <h2 class="modal-title fs-5" id="aiSettingsModalLabel">配置 API</h2>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                    </div>
                    <div class="modal-body modal-body--scroll">
                        <p v-if="settingsError" class="alert alert-danger" role="alert">[[ settingsError ]]</p>
                        <p v-if="settingsLoading" class="text-secondary" role="status">正在读取当前配置…</p>
                        <form id="ai-settings-form" @submit.prevent="saveSettings">
                            <div class="config-modal-grid">
                                <section class="config-section-card mb-3" aria-label="已配置的模型服务">
                                    <div class="config-section-heading">
                                        <span class="config-section-index">00</span>
                                        <div><h3>模型服务</h3><p>可存多组，点一下就切换。同时只有一组生效。</p></div>
                                    </div>
                                    <div class="ai-provider-list">
                                        <div v-for="row in providers" :key="row.id"
                                             class="ai-provider-card" :class="{'is-active': row.is_active}">
                                            <div class="ai-provider-card__main">
                                                <p class="ai-provider-card__name">
                                                    [[ row.name ]]
                                                    <span v-if="row.is_active" class="ai-provider-card__badge">当前</span>
                                                </p>
                                                <p class="ai-provider-card__meta">
                                                    [[ row.base_url || '未填地址' ]] · [[ row.chat_model || '未填模型' ]]
                                                    <span v-if="!row.has_key"> · 没有密钥</span>
                                                </p>
                                            </div>
                                            <div class="ai-provider-card__actions">
                                                <button v-if="!row.is_active" class="btn btn-sm btn-outline-primary"
                                                        type="button" @click="activateProvider(row)">切换到此</button>
                                                <button class="btn btn-sm btn-link text-danger" type="button"
                                                        @click="deleteProvider(row)">删除</button>
                                            </div>
                                        </div>
                                        <p v-if="!providers.length" class="text-body-secondary small mb-0">
                                            还没有配置。下面填一组，保存后自动成为当前配置。
                                        </p>
                                    </div>
                                </section>
                                <section class="config-section-card" aria-label="服务端点">
                                    <div class="config-section-heading">
                                        <span class="config-section-index">01</span>
                                        <div><h3>服务端点</h3>
                                            <p>任何 OpenAI 兼容接口都能接：选一个内置的，或者自己填地址。Key 只存密文，页面不回显。</p></div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-preset">提供方</label>
                                        <select class="form-select" id="ai-preset" v-model="preset" @change="applyPreset">
                                            <option value="">自定义</option>
                                            <option v-for="item in presets" :key="item.name" :value="item.name">[[ item.name ]]</option>
                                        </select>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-base-url">接口地址（Base URL）</label>
                                        <input class="form-control" id="ai-base-url" type="text" v-model.trim="settingsForm.base_url"
                                               placeholder="https://api.example.com/v1" autocomplete="off">
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-api-key">API Key（留空表示不修改）</label>
                                        <input class="form-control" id="ai-api-key" type="password" v-model="settingsForm.api_key"
                                               :placeholder="hasApiKey ? '已保存，留空表示不修改' : '粘贴密钥'"
                                               autocomplete="new-password">
                                        <p class="form-text mb-0" id="ai-api-key-help">
                                            只存密文，不回显。
                                            <span v-if="hasApiKey">当前已保存密钥。</span>
                                        </p>
                                    </div>
                                    <div class="d-flex justify-content-between align-items-center">
                                        <button class="btn btn-sm btn-outline-secondary" type="button"
                                                :disabled="!hasApiKey" @click="clearApiKey">清除已存 Key</button>
                                        <button class="btn btn-sm btn-primary" type="button"
                                                :disabled="settingsSaving" @click="saveSettings">
                                            [[ settingsSaving ? '保存中…' : '保存云端设置' ]]
                                        </button>
                                    </div>
                                </section>
                                <section class="config-section-card" aria-label="模型与检索">
                                    <div class="config-section-heading">
                                        <span class="config-section-index">02</span>
                                        <div><h3>模型与检索</h3><p>问答模型、向量模型与召回阈值；阈值留空沿用环境变量。</p></div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-chat-model">Chat 模型</label>
                                        <input class="form-control" id="ai-chat-model" type="text" v-model.trim="settingsForm.chat_model" autocomplete="off">
                                    </div>
                                        <div class="mb-3">
                                            <label class="form-label" for="ai-models-text">模型名（逗号分隔）</label>
                                            <input class="form-control" id="ai-models-text" type="text"
                                                   v-model="settingsForm.models_text"
                                                   placeholder="deepseek-chat, deepseek-reasoner">
                                            <p class="form-text mb-0">输入框下方的模型下拉从这里取；留空则只有上面这一个。</p>
                                        </div>
                                        <div class="mb-3">
                                        <label class="form-label" for="ai-embed-model">Embedding 模型</label>
                                        <input class="form-control" id="ai-embed-model" type="text" v-model.trim="settingsForm.embed_model" autocomplete="off">
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-rag-backend">检索方式</label>
                                        <select class="form-select" id="ai-rag-backend" v-model="settingsForm.rag_backend">
                                            <option value="hybrid">混合（向量 + 关键词）</option>
                                <option value="vector">仅向量</option>
                                <option value="keyword">仅关键词</option>
                                        </select>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label" for="ai-vector-distance">向量阈值</label>
                                        <input class="form-control" id="ai-vector-distance" type="number" step="0.01" min="0" max="2"
                                               v-model="settingsForm.retrieval_max_distance">
                                    </div>
                                    <div class="mb-0">
                                        <label class="form-label" for="ai-keyword-distance">关键词阈值</label>
                                        <input class="form-control" id="ai-keyword-distance" type="number" step="0.01" min="0" max="1"
                                               v-model="settingsForm.keyword_max_distance">
                                    </div>
                                </section>
                                <section class="config-section-card mb-3" aria-label="会话与思考">
                                <div class="config-section-heading">
                                    <span class="config-section-index">03</span>
                                    <div><h3>会话与思考</h3><p>上下文压缩控制长对话怎么带历史；思考模式按模型支持情况选择。</p></div>
                                </div>
                                    <div class="row g-3">
                                        <div class="col-md-4">
                                            <label class="form-label" for="ai-max-history">保留最近消息</label>
                                            <input class="form-control" id="ai-max-history" type="number" min="2" max="50"
                                                   v-model.number="settingsForm.max_history">
                                            <p class="form-text mb-0">每次带给模型的消息条数。</p>
                                        </div>
                                        <div class="col-md-4">
                                            <label class="form-label" for="ai-summary-trigger">压缩触发条数</label>
                                            <input class="form-control" id="ai-summary-trigger" type="number" min="4" max="200"
                                                   v-model.number="settingsForm.summary_trigger">
                                            <p class="form-text mb-0">总消息超过此数才把旧消息压成摘要。</p>
                                        </div>
                                        <div class="col-md-4">
                                            <label class="form-label" for="ai-reasoning">思考模式</label>
                                            <select class="form-select" id="ai-reasoning" v-model="settingsForm.reasoning_effort">
                                                <option value="">不传（跟随模型默认）</option>
                                                <option value="low">low</option>
                                                <option value="medium">medium</option>
                                                <option value="high">high</option>
                                            </select>
                                            <p class="form-text mb-0">模型不支持时选「不传」。</p>
                                        </div>
                                    </div>
                                </section>
                            </div>
                        </form>
                    </div>
                    <div class="modal-footer modal-footer--sticky">
                        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>
                        <button type="submit" class="btn btn-primary" form="ai-settings-form" :disabled="settingsSaving || settingsLoading">
                            [[ settingsSaving ? '保存中…' : '保存' ]]
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="is_admin" class="modal fade" id="aiKnowledgeModal" ref="knowledgeModal" tabindex="-1"
             aria-labelledby="aiKnowledgeModalLabel" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable modal-shell">
                <div class="modal-content modal-surface">
                    <div class="modal-header">
                        <h2 class="modal-title fs-5" id="aiKnowledgeModalLabel">添加知识库条目</h2>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                    </div>
                    <div class="modal-body modal-body--scroll">
                        <p v-if="knowledgeError" class="alert alert-danger" role="alert">[[ knowledgeError ]]</p>
                        <section class="config-section-card mb-3" aria-label="测试检索">
                        <div class="config-section-heading">
                            <span class="config-section-index">03</span>
                            <div><h3>测试检索</h3><p>直接跑一遍 retrieve()，看每条为什么进、为什么没进。调阈值别靠猜。</p></div>
                        </div>
                        <div class="d-flex gap-2 mb-2">
                            <input class="form-control" type="text" v-model="probeQuery"
                                   placeholder="输入一句运维问题，例如：S5735 端口不通"
                                   @keydown.enter.prevent="runProbe">
                            <button class="btn btn-outline-primary text-nowrap" type="button"
                                    :disabled="probing || !probeQuery.trim()" @click="runProbe">
                                [[ probing ? '检索中…' : '试一下' ]]
                            </button>
                        </div>
                        <p v-if="probeError" class="text-danger small mb-2">[[ probeError ]]</p>
                        <p v-if="probeDone" class="small mb-2">
                            命中 [[ probeHits.length ]] 条
                            <span v-if="!probeHits.length">—— 说明这条问题在知识库里找不到依据，会被拒答。</span>
                        </p>
                        <table v-if="probeHits.length" class="table table-sm small mb-0">
                            <thead><tr><th>标题</th><th>分类</th><th>距离</th><th>得分</th><th>来源</th></tr></thead>
                            <tbody>
                                <tr v-for="hit in probeHits" :key="hit.title">
                                    <td>[[ hit.title ]]</td>
                                    <td>[[ hit.category ]]</td>
                                    <td>[[ hit.distance ]]</td>
                                    <td>[[ hit.score === null ? '—' : hit.score ]]</td>
                                    <td>[[ hit.via ]]</td>
                                </tr>
                            </tbody>
                        </table>
                    </section>
                    <section class="config-section-card mb-3" aria-label="知识库现状">
                            <div class="config-section-heading">
                                <span class="config-section-index">00</span>
                                <div><h3>知识库现状</h3><p>新增条目先落库，向量要跑 build_knowledge 才建。</p></div>
                            </div>
                            <p class="mb-0" role="status">
                                共 <strong>[[ knowledge.total ]]</strong> 条，已建向量 <strong>[[ knowledge.embedded ]]</strong> 条。
                                <button type="button" class="btn btn-outline-secondary btn-sm ms-2" :disabled="knowledgeLoading" @click="loadKnowledge">
                                    [[ knowledgeLoading ? '读取中…' : '刷新' ]]
                                </button>
                            </p>
                        </section>
                        <section class="config-section-card mb-3" aria-label="单条添加">
                            <div class="config-section-heading">
                                <span class="config-section-index">01</span>
                                <div><h3>单条添加</h3><p>一条手册片段或处置经验，标题写清设备与场景。</p></div>
                            </div>
                            <p v-if="addError" class="alert alert-danger" role="alert">[[ addError ]]</p>
                            <p v-if="addMessage" class="alert alert-success" role="status">[[ addMessage ]]</p>
                            <form @submit.prevent="addKnowledge">
                                <div class="row g-3">
                                    <div class="col-12 col-md-8">
                                        <label class="form-label" for="ai-knowledge-title">标题</label>
                                        <input class="form-control" id="ai-knowledge-title" type="text" v-model="knowledgeForm.title" autocomplete="off">
                                    </div>
                                    <div class="col-12 col-md-4">
                                        <label class="form-label" for="ai-knowledge-category">分类</label>
                                        <select class="form-select" id="ai-knowledge-category" v-model="knowledgeForm.category">
                                <option value="">未分类</option>
                                <option v-for="item in categories" :key="item" :value="item">[[ item ]]</option>
                            </select>
                                    </div>
                                    <div class="col-12">
                                        <label class="form-label" for="ai-knowledge-content">内容</label>
                                        <textarea class="form-control" id="ai-knowledge-content" rows="4" v-model="knowledgeForm.content"></textarea>
                                    </div>
                                </div>
                                <button type="submit" class="btn btn-primary mt-3" :disabled="adding">[[ adding ? '保存中…' : '保存这一条' ]]</button>
                            </form>
                        </section>
                        <section class="config-section-card mb-0" aria-label="表格导入">
                            <div class="config-section-heading">
                                <span class="config-section-index">02</span>
                                <div><h3>表格导入</h3><p>从 Excel 直接粘贴或粘 CSV；列顺序：标题、内容、分类。</p></div>
                            </div>
                            <p v-if="importError" class="alert alert-danger" role="alert">[[ importError ]]</p>
                            <p v-if="importMessage" class="alert alert-success" role="status">[[ importMessage ]]</p>
                            <ul v-if="importSkipped.length" class="ai-chat__skipped" aria-label="跳过明细">
                                <li v-for="(item, index) in importSkipped" :key="index">第 [[ item.line ]] 行：[[ item.reason ]]</li>
                            </ul>
                            <div class="mb-2">
                            <label class="form-label" for="ai-import-file">选择文件</label>
                            <input class="form-control" type="file" id="ai-import-file"
                                   accept=".csv,.txt,.tsv,text/csv,text/plain"
                                   @change="onFilePicked">
                        </div>
                        <p class="text-body-secondary small mb-2">
                            支持 CSV / TXT / TSV，三列依次是标题、内容、分类，首行可以是表头。
                            Excel 请先「另存为 CSV（逗号分隔）」——.xlsx 是二进制格式，读不了。
                        </p>
                        <p v-if="importName" class="small mb-2">
                            已选：[[ importName ]]
                            <button class="btn btn-sm btn-link p-0 ms-2 align-baseline"
                                    type="button" @click="clearFile">清除</button>
                        </p>
                        <p v-if="importError" class="text-danger small mb-2">[[ importError ]]</p>
                        <p v-if="importMessage" class="text-success small mb-2">[[ importMessage ]]</p>
                        <ul v-if="importSkipped.length" class="small text-body-secondary mb-2">
                            <li v-for="item in importSkipped" :key="item.line">
                                第 [[ item.line ]] 行：[[ item.reason ]]
                            </li>
                        </ul>
                            <p class="form-text">支持逗号或制表符分隔；首行是表头会自动跳过；字段里的逗号用引号包起来。</p>
                            <button type="button" class="btn btn-primary mt-2" :disabled="importing" @click="runImport">
                                [[ importing ? '导入中…' : '导入' ]]
                            </button>
                        </section>
                    </div>
                    <div class="modal-footer modal-footer--sticky">
                        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
`,
};
