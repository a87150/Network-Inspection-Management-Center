/* AI 助手：单用户单会话问答。历史、提问、清空全走 REST，无流式。 */
import { api } from '../api.mjs';

export default {
    delimiters: ['[[', ']]'],
    props: {
        // 默认值与 ai_assistant/urls.py 里的挂载点一致；bootstrap 只做覆盖。
        chat_url: {type: String, default: '/api/ai/chat/'},
        history_url: {type: String, default: '/api/ai/history/'},
        reset_url: {type: String, default: '/api/ai/reset/'},
    },
    data() {
        return {
            messages: [],
            draft: '',
            loading: false,
            sending: false,
            resetting: false,
            // 清空会删历史，点一次只是待确认，点第二次才真发请求。
            confirmReset: false,
            error: '',
        };
    },
    computed: {
        canSend() {
            return this.draft.trim().length > 0 && !this.sending;
        },
    },
    mounted() {
        this.loadHistory();
    },
    methods: {
        sourceLabel(source) {
            if (typeof source.distance === 'number') {
                return source.title + ' · 余弦距离 ' + source.distance.toFixed(3);
            }
            return source.title;
        },
        async loadHistory() {
            this.loading = true;
            this.error = '';
            try {
                const payload = await api.get(this.history_url);
                this.messages = (payload && payload.messages) || [];
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
    <section class="ai-chat__panel glass-panel" aria-labelledby="ai-chat-panel-title">
        <header class="ai-chat__panel-head">
            <div>
                <h2 class="ai-chat__panel-title" id="ai-chat-panel-title">知识库问答</h2>
                <p class="ai-chat__panel-hint">只依据知识库作答；问设备手册、巡检规则、日志排查、故障处置。</p>
            </div>
            <div class="ai-chat__panel-actions">
                <p v-if="confirmReset" class="ai-chat__reset-hint" role="alert">再次点击即清空，历史无法恢复。</p>
                <button type="button" class="ai-chat__reset" :disabled="resetting || sending" @click="requestReset">
                    [[ resetting ? '清空中…' : (confirmReset ? '确认清空' : '清空会话') ]]
                </button>
            </div>
        </header>

        <p v-if="error" class="ai-chat__error" role="alert">[[ error ]]</p>

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
                      placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                      @keydown.enter.exact.prevent="send"></textarea>
            <button type="submit" :disabled="!canSend">[[ sending ? '发送中…' : '发送' ]]</button>
        </form>
    </section>
    `,
};
