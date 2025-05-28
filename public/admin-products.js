<script>
    async function loadProducts() {
      const res = await fetch('/admin/api/products');
      const products = await res.json();
      const tbody = document.getElementById('productTableBody');
      tbody.innerHTML = '';

      for (const p of products) {
        // Fetch credentials for this product
        const credRes = await fetch(`/admin/products/${p.id}/credentials`);
        const creds = credRes.ok ? await credRes.json() : [];

        // Build credentials HTML
        let credList = '';
        if (creds.length > 0) {
          credList = creds.map(c => `
            <div class="credential-row">
              <input type="email" id="email-${c.id}" value="${c.email}" style="width: 180px;" />
              <input type="text" id="password-${c.id}" value="${c.password}" style="width: 120px;" />
              <button onclick="updateCredential(${p.id}, ${c.id})">Save</button>
              <button onclick="deleteCredential(${p.id}, ${c.id})">Delete</button>
            </div>
          `).join('');
        } else {
          credList = '<i>No credentials</i>';
        }

        // Add form to add new credential for this product
        credList += `
          <div style="margin-top:8px;">
            <input type="email" id="new-email-${p.id}" placeholder="New Email" style="width: 180px;" />
            <input type="text" id="new-password-${p.id}" placeholder="New Password" style="width: 120px;" />
            <button onclick="addCredential(${p.id})">Add Credential</button>
          </div>
        `;

        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${p.id}</td>
          <td>${p.name}</td>
          <td>${p.description}</td>
          <td>${p.price}</td>
          <td><img src="${p.image_url}" alt="Image"></td>
          <td>${credList}</td>
          <td><button onclick="deleteProduct(${p.id})">Delete Product</button></td>
        `;
        tbody.appendChild(row);
      }
    }

    async function deleteProduct(id) {
      if (confirm('Are you sure you want to delete this product?')) {
        const res = await fetch('/admin/products/' + id, { method: 'DELETE' });
        if (res.ok) {
          alert('Product deleted');
          loadProducts();
        } else {
          alert('Failed to delete product');
        }
      }
    }

    async function addCredential(productId) {
      const emailInput = document.getElementById(`new-email-${productId}`);
      const passwordInput = document.getElementById(`new-password-${productId}`);
      const email = emailInput.value.trim();
      const password = passwordInput.value.trim();

      if (!email || !password) {
        alert('Please enter both email and password');
        return;
      }

      const res = await fetch(`/admin/products/${productId}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        alert('Credential added');
        emailInput.value = '';
        passwordInput.value = '';
        loadProducts();
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Failed to add credential'));
      }
    }

    async function updateCredential(productId, credId) {
      const email = document.getElementById(`email-${credId}`).value.trim();
      const password = document.getElementById(`password-${credId}`).value.trim();
      if (!email || !password) {
        alert('Please enter both email and password');
        return;
      }

      const res = await fetch(`/admin/products/${productId}/credentials/${credId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        alert('Credential updated');
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Failed to update credential'));
      }
    }

    async function deleteCredential(productId, credId) {
      if (!confirm('Are you sure you want to delete this credential?')) return;

      const res = await fetch(`/admin/products/${productId}/credentials/${credId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        alert('Credential deleted');
        loadProducts();
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Failed to delete credential'));
      }
    }

    document.getElementById('addProductForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        name: document.getElementById('name').value,
        description: document.getElementById('description').value,
        price: document.getElementById('price').value,
        image_url: document.getElementById('image_url').value
      };
      const res = await fetch('/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        e.target.reset();
        loadProducts();
      } else {
        alert('Failed to add product');
      }
    });

    loadProducts();
  </script>