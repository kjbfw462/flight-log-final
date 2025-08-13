(async () => {
    // ログインページでは認証チェックを行わない
    if (window.location.pathname.endsWith('/login.html')) {
        return;
    }
    try {
        const res = await fetch('/api/current-user');
        if (res.status === 401) {
             // サーバーから401が返ってきたら明確にログインページへ
            window.location.href = '/login.html';
            return;
        }
        const data = await res.json();
        if (!data.user) {
            window.location.href = '/login.html';
            return;
        }
        renderHeaderUI(data.user);
    } catch (err) {
        // fetch自体が失敗した場合（サーバーがダウンしているなど）
        console.error('Authentication error:', err);
        window.location.href = '/login.html';
    }
})();

function renderHeaderUI(user) {
    const headerUI = document.createElement('div');
    headerUI.style.position = 'fixed';
    headerUI.style.top = '10px';
    headerUI.style.right = '20px';
    headerUI.style.zIndex = '9999';
    headerUI.style.display = 'flex';
    headerUI.style.alignItems = 'center';
    headerUI.style.gap = '15px';
    headerUI.style.backgroundColor = 'white';
    headerUI.style.padding = '8px 15px';
    headerUI.style.borderRadius = '20px';
    headerUI.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    headerUI.style.fontSize = '14px';
    headerUI.innerHTML = `
        <span>こんにちは、<strong>${user.name}</strong>さん</span>
        <button id="logout-btn" style="border:none; background-color:#ef4444; color:white; padding: 6px 12px; border-radius:15px; cursor:pointer;">ログアウト</button>
    `;
    document.body.prepend(headerUI);

    document.getElementById('logout-btn').addEventListener('click', async () => {
        if (!confirm('ログアウトしますか？')) return;
        try {
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = '/login.html';
        } catch (err) {
            alert('ログアウトに失敗しました。');
        }
    });
}