(async () => {
    if (window.location.pathname.endsWith('/login.html')) {
        return;
    }
    try {
        const res = await fetch('/api/current-user');
        if (res.status === 401) {
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
        console.error('Authentication error:', err);
        window.location.href = '/login.html';
    }
})();

function renderHeaderUI(user) {
    const headerUI = document.createElement('div');
    headerUI.style.cssText = `
        position: fixed; top: 10px; right: 20px; z-index: 9999;
        display: flex; align-items: center; gap: 15px;
        background-color: white; padding: 8px 15px;
        border-radius: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        font-size: 14px;
    `;
    headerUI.innerHTML = `
        <span>こんにちは、<strong>${user.name}</strong>さん</span>
        <button id="logout-btn" style="border:none; background-color:#dc3545; color:white; padding: 6px 12px; border-radius:15px; cursor:pointer;">ログアウト</button>
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