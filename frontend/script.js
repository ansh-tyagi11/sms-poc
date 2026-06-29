const form = document.getElementById('campaignForm');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');

let activeController = null;

form.addEventListener('submit', sendMessage);
stopBtn.addEventListener('click', stopMessage);

function setSendingState(isSending) {
    sendBtn.disabled = isSending;
    stopBtn.disabled = !isSending;
}

function stopMessage() {
    if (activeController) {
        activeController.abort();
    }
}

async function sendMessage(e) {
    e.preventDefault();
    const file =
        document.getElementById('excel').files[0];
    const message =
        document.getElementById('message').value;
    const channel =
        document.getElementById('channel').value;


    const formData = new FormData();
    if (!file) {
        alert('Please choose an Excel file first.');
        return;
    }

    if (activeController) {
        activeController.abort();
    }

    activeController = new AbortController();
    setSendingState(true);
    status.innerHTML = '<p>Sending campaign...</p>';

    formData.append('file', file);
    formData.append('message', message);
    formData.append('channel', channel);

    try {
        const response = await fetch(`/send-message`, {
            method: 'POST',
            body: formData,
            signal: activeController.signal
        });

        const data = await response.json();
        status.innerHTML = `
            <p>${data.message}</p>
            <p>Channel: ${String(data.channel || channel).toUpperCase()}</p>
            <p>Total Contacts: ${data.total}</p>
            <p>Delivery Attempts: ${data.attempts ?? data.total}</p>
            <p>Messages Sent: ${data.sent}</p>
            <p>Messages Failed: ${data.failed}</p>
        `;
        form.reset();

    } catch (error) {
        if (error.name === 'AbortError') {
            status.innerHTML = '<p>Campaign stopped.</p>';
        } else {
            status.innerHTML = `<p>Failed to send campaign: ${error.message}</p>`;
        }
    } finally {
        activeController = null;
        setSendingState(false);
    }
}
