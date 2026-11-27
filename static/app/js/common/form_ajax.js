/* 模态框表单的 fetch 提交。
   失败时把错误留在框里，成功后关弹窗 + 页内刷新表格 + 派发 app:modal-updated，
   地址栏保持不动。普通表单（没有 data-form-ajax）不受影响。 */
(function () {
    'use strict';

    function flashText(html) {
        try {
            var page = new DOMParser().parseFromString(html, 'text/html');
            return String(page.querySelector('[data-flash-message]')?.textContent || '').trim();
        } catch (_error) {
            return '';
        }
    }

    /* 保存成功：关掉弹窗，页内换掉表格内容，并通知页面自己重取。 */
    function afterSave(form, message) {
        var doc = form.ownerDocument || document;
        var win = doc.defaultView || window;
        var modal = form.closest('.modal');
        if (modal) win.bootstrap?.Modal.getInstance?.(modal)?.hide();
        var region = doc.getElementById('app-live-region');
        if (region && message) region.textContent = message;
        var controller = win.AppTableWorkspace;
        if (doc.querySelector('[data-table-workspace]')
            && typeof controller?.refreshTableWorkspaces === 'function') {
            var storage = null;
            try {
                storage = win.localStorage;
            } catch (_error) {
                storage = null;
            }
            controller.refreshTableWorkspaces(doc, win.location.href, storage, win);
        }
        doc.dispatchEvent(new win.CustomEvent('app:modal-updated', {detail: {modal: modal || null}}));
    }

    function errorBox(form) {
        var body = form.querySelector('.modal-body') || form;
        var box = body.querySelector('[data-form-ajax-errors]');
        if (!box) {
            box = document.createElement('div');
            box.className = 'alert alert-danger';
            box.setAttribute('role', 'alert');
            box.setAttribute('data-form-ajax-errors', '');
            body.insertBefore(box, body.firstChild);
        }
        return box;
    }

    function showErrors(form, title, errors) {
        var box = errorBox(form);
        box.textContent = '';
        var heading = document.createElement('strong');
        heading.textContent = title;
        box.appendChild(heading);
        if (errors.length) {
            var list = document.createElement('ul');
            list.className = 'mb-0';
            errors.forEach(function (message) {
                var item = document.createElement('li');
                item.textContent = message;
                list.appendChild(item);
            });
            box.appendChild(list);
        }
        box.scrollIntoView({ block: 'nearest' });
    }

    function clearErrors(form) {
        var box = form.querySelector('[data-form-ajax-errors]');
        if (box) {
            box.remove();
        }
    }

    document.addEventListener('submit', function (event) {
        var form = event.target.closest('form[data-form-ajax]');
        if (!form) {
            return;
        }
        event.preventDefault();
        /* 用 event.submitter：保存按钮可能在 form 之外、靠 form= 属性关联
           （告警模板、PC 配置、巡检项设置三处真模板都是这样）。这时
           querySelector('[type="submit"]') 要么拿到 null（防重复完全失效，
           双击就发两份 POST），要么拿到表单里另一个 submit（比如「测试发送」），
           禁用的是根本没在提交的那个按钮。 */
        var submitter = event.submitter || form.querySelector('[type="submit"]');
        if (submitter) {
            if (submitter.disabled) {
                return;
            }
            submitter.disabled = true;
        }
        clearErrors(form);
        fetch(form.action, {
            method: 'POST',
            body: new FormData(form),
            headers: { 'X-Form-Ajax': '1' },
            credentials: 'same-origin',
        }).then(function (response) {
            var type = response.headers.get('content-type') || '';
            if (type.indexOf('application/json') === -1) {
                /* 非 JSON 不等于成功：视图未捕获异常是 500 HTML，CSRF 拒绝是 403 HTML，
                   反代/网关错误是 502 HTML。原来一律走 afterSave，用户填的内容随
                   弹窗关闭消失，界面一句提示都没有。先看状态码再决定。 */
                if (!response.ok) {
                    return response.text().then(function () {
                        showErrors(form, '保存失败', [
                            '服务器返回 ' + response.status + '，内容未保存，请重试或联系管理员。',
                        ]);
                    });
                }
                /* 成功：服务端重定向到了带 flash 消息的页面，只取那条消息播报。 */
                return response.text().then(function (html) {
                    afterSave(form, flashText(html));
                });
            }
            return response.json().then(function (payload) {
                if (payload.ok) {
                    afterSave(form, payload.message || '');
                    return;
                }
                showErrors(form, '保存失败', payload.errors || []);
            });
        }).catch(function () {
            showErrors(form, '保存失败', ['网络异常，请重试。']);
        }).then(function () {
            if (submitter) {
                submitter.disabled = false;
            }
        });
    });
})();
