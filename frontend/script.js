const btn = document.getElementById('sendBtn');

btn.addEventListener('click', sendMessage);

function sendMessage(e) {
    e.preventDefault();
    const file =
        document.getElementById('excel').files[0];
    const message =
        document.getElementById('message').value;
    const channel =
        document.getElementById('channel').value;
    const status
        = document.getElementById('status');


    const formData = new FormData();
    if (!file) {
        alert('Please choose an Excel file first.');
        return;
    }

    formData.append('file', file);
    formData.append('message', message);
    formData.append('channel', channel);

    for (let pair of formData.entries()) {
        console.log(pair[0], pair[1]);
    }

    let res = fetch('http://localhost:4000/send-message', {
        method: 'POST',
        body: formData
    }).then(response => response.json())
        .then(data => {
            console.log(data);
            // alert(data.message);
            status.innerHTML = `
                <p>Total Contacts: ${data.total}</p>
                <p>Messages Sent: ${data.sent}</p>
                <p>Messages Failed: ${data.failed}</p>
            `;

        }
        )
}
