document.addEventListener('DOMContentLoaded', () => {
  const el = id => document.getElementById(id);
  const pathname = window.location.pathname;

  // === USER SITE CODE ===
  if (!pathname.includes('admin.html') && !pathname.includes('addproduct.html')) {
    const productsContainer = el('products-container');
    const searchInput = el('search');
    const buyPopup = el('buy-popup');
    const popupProductName = el('popup-product-name');
    const buyerEmailInput = el('buyer-email');
    const confirmBuyBtn = el('confirm-buy');
    const cancelBuyBtn = el('cancel-buy');
    const notification = el('notification');
    const logo = el('logo');
    const screenshotBtn = el('upload-btn');
    const popupCloseBtn = document.querySelector('.popup-close');

    let products = [];
    let selectedProduct = null;
    let logoClickCount = 0;
    let logoClickTimeout = null;

    function showNotification(message) {
      if (!notification) return;
      notification.textContent = message;
      notification.classList.remove('hidden');
      setTimeout(() => notification.classList.add('hidden'), 4000);
    }

    function validateEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    async function fetchProducts() {
      try {
        const res = await fetch('/api/products');
        if (!res.ok) throw new Error('Server error');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Invalid data');
        products = data;
        renderProducts(products);
      } catch (err) {
        console.error('Product fetch error:', err);
        showNotification('Failed to load products');
      }
    }

	function renderProducts(items) {
	  if (!productsContainer) return;
	  productsContainer.innerHTML = '';

	  if (!items.length) {
		productsContainer.innerHTML = `
		  <div class="no-results" style="width:100%; text-align:center; padding:1rem;">
			<p>No products found.</p>
		  </div>
		`;
		
		return;
	  }

	  items.forEach(p => {
		const card = document.createElement('div');
		card.className = 'product-card';
		card.innerHTML = `
		  <img src="${p.image_url}" alt="${p.name}" class="product-img">
		  <div class="product-info">
			<h3>${p.name}</h3>
			<p class="description">${p.description}</p>
			<p class="price">$${parseFloat(p.price).toFixed(2)}</p>
			<button class="buy-btn" data-id="${p.id}">Buy</button>
		  </div>
		`;
		productsContainer.appendChild(card);
	  });
	}

    searchInput?.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();
      const filtered = products.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query)
      );
      renderProducts(filtered);
    });

    productsContainer?.addEventListener('click', e => {
      const btn = e.target.closest('.buy-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      selectedProduct = products.find(p => p.id == id);
      if (!selectedProduct) return;

      popupProductName.textContent = selectedProduct.name;
      buyerEmailInput.value = '';
      buyPopup.classList.remove('hidden');
      buyerEmailInput.focus();
    });

    popupCloseBtn?.addEventListener('click', () => {
      buyPopup.classList.add('hidden');
      selectedProduct = null;
    });

    cancelBuyBtn?.addEventListener('click', () => {
      buyPopup.classList.add('hidden');
      selectedProduct = null;
    });

    confirmBuyBtn?.addEventListener('click', async () => {
      const email = buyerEmailInput.value.trim();
      if (!validateEmail(email)) return alert('Enter a valid email.');
      if (!selectedProduct) return;

      confirmBuyBtn.disabled = true;
      confirmBuyBtn.textContent = 'Processing...';

      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: selectedProduct.id, buyerEmail: email })
        });

        if (res.ok) {
          showNotification('Order placed! Check your email.');
          buyPopup.classList.add('hidden');
          selectedProduct = null;
        } else {
          const data = await res.json();
          alert(data.message || 'Failed to place order');
        }
      } catch (err) {
        console.error('Order error:', err);
        alert('Network error.');
      } finally {
        confirmBuyBtn.disabled = false;
        confirmBuyBtn.textContent = 'Buy';
      }
    });

    logo?.addEventListener('click', () => {
      logoClickCount++;
      clearTimeout(logoClickTimeout);
      logoClickTimeout = setTimeout(() => (logoClickCount = 0), 800);

      if (logoClickCount === 3) {
        logoClickCount = 0;
        const password = prompt('Enter admin password:');
        if (!password) return;

        fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'fastfire9', password })
        })
          .then(res => {
            if (res.ok) {
              window.location.href = '/admin.html';
            } else {
              alert('Wrong username or password');
            }
          })
          .catch(() => alert('Network error'));
      }
    });

    screenshotBtn?.addEventListener('click', () => {
      window.location.href = '/upload.html';
    });

    fetchProducts();
  }

  // === ADMIN PANEL CODE ===
  else if (pathname.includes('admin.html')) {
    const logoutBtn = el('logout-btn');
    const addProductBtn = el('add-product-btn');
    const ordersTableBody = document.querySelector('#orders-table tbody');
    const productsTableBody = document.querySelector('#products-table tbody');
    const orderSearchInput = el('order-search');

    let orders = [];
    let products = [];

    function showNotification(msg) {
      const notif = el('admin-notification');
      if (!notif) return;
      notif.textContent = msg;
      notif.classList.remove('hidden');
      setTimeout(() => notif.classList.add('hidden'), 4000);
    }

    async function loadOrders() {
      try {
        const res = await fetch('/api/admin/orders');
        if (!res.ok) throw new Error('Failed to fetch orders');
        orders = await res.json();
        renderOrders(orders);
      } catch (e) {
        console.error(e);
        ordersTableBody.innerHTML = `<tr><td colspan="6">Error loading orders</td></tr>`;
      }
    }

	function renderOrders(orderList) {
	  if (!ordersTableBody) return;
	  ordersTableBody.innerHTML = '';
	  if (!orderList.length) {
		ordersTableBody.innerHTML = `<tr><td colspan="6">No orders available</td></tr>`;
		return;
	  }

	  orderList.forEach(o => {
		const showActions = ['pending', 'flagged'].includes(o.status);

		ordersTableBody.innerHTML += `
		  <tr>
			<td>${o.buyer_id}</td>
			<td>${o.buyer_email}</td>
			<td>${o.product_name}</td>
			<td>${o.status}</td>
			<td>
			  ${showActions ? `
				<button class="accept-btn" data-id="${o.buyer_id}">Accept Order</button>
				<button class="complete-btn" data-id="${o.buyer_id}">Accept Sale</button>
				<button class="decline-btn" data-id="${o.buyer_id}">Decline</button>
			  ` : '—'}
			</td>
		  </tr>
		`;
	  });
	}
	
    async function loadProducts() {
      try {
        const res = await fetch('/api/products');
        if (!res.ok) throw new Error('Failed to fetch products');
        products = await res.json();
        renderProducts(products);
      } catch (e) {
        console.error(e);
        productsTableBody.innerHTML = `<tr><td colspan="5">Error loading products</td></tr>`;
      }
    }

    function renderProducts(productList) {
      if (!productsTableBody) return;
      productsTableBody.innerHTML = '';
      if (!productList.length) {
        productsTableBody.innerHTML = `<tr><td colspan="5">No products available</td></tr>`;
        return;
      }
      productList.forEach(p => {
        productsTableBody.innerHTML += `
          <tr>
            <td>${p.id}</td>
            <td>${p.name}</td>
            <td>$${parseFloat(p.price).toFixed(2)}</td>
            <td>${p.credentials?.emails?.join(', ') || '—'}</td>
            <td>
              <button class="edit-product-btn" data-id="${p.id}">Edit</button>
              <button class="delete-product-btn" data-id="${p.id}">Delete</button>
            </td>
          </tr>`;
      });
    }

    logoutBtn?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/admin/logout', { method: 'POST' });
        if (res.ok) window.location.href = '/';
        else alert('Logout failed');
      } catch {
        alert('Network error during logout');
      }
    });

    addProductBtn?.addEventListener('click', () => {
      window.location.href = '/addproduct.html';
    });

	ordersTableBody?.addEventListener('click', async (e) => {
	  const id = e.target.dataset.id;
	  if (!id) return;

	  if (e.target.classList.contains('accept-btn')) {
		await handleOrderAction(id, 'accept');
	  }
	  if (e.target.classList.contains('complete-btn')) {
		await handleOrderAction(id, 'complete');
	  }
	  if (e.target.classList.contains('decline-btn')) {
		await handleOrderAction(id, 'decline');
	  }
	});

	async function handleOrderAction(id, action) {
	  try {
		const res = await fetch(`/api/admin/orders/${id}/${action}`, { method: 'POST' });
		if (res.ok) {
		  await loadOrders(); // ✅ this reloads orders
		} else {
		  const err = await res.json();
		  alert(err.error || 'Action failed');
		}
	  } catch {
		alert('Network error');
	  }
	}

    productsTableBody?.addEventListener('click', (e) => {
      const id = e.target.dataset.id;
      if (e.target.classList.contains('edit-product-btn')) {
        window.location.href = `/addproduct.html?id=${id}`;
      }
      if (e.target.classList.contains('delete-product-btn')) {
        if (confirm('Delete this product?')) {
          fetch(`/api/products/${id}`, { method: 'DELETE' })
            .then(res => {
              if (res.ok) {
                showNotification('Product deleted.');
                loadProducts();
              } else alert('Failed to delete product');
            })
            .catch(() => alert('Network error deleting product'));
        }
      }
    });

	orderSearchInput?.addEventListener('input', () => {
	  const q = orderSearchInput.value.toLowerCase();
	  const filtered = orders.filter(o =>
		o.buyer_email.toLowerCase().includes(q) ||
		o.product_name.toLowerCase().includes(q) ||
		o.buyer_id.toLowerCase().includes(q)  // ✅ Add this
	  );
	  renderOrders(filtered);
	});

    loadOrders();
    loadProducts();
  }

  // === ADD PRODUCT PAGE LOGIC ===
  else if (pathname.includes('addproduct.html')) {
    const form = el('product-form');
    const backBtn = el('back-btn');

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) {
      fetch(`/api/admin/product/${id}`)
        .then(res => res.json())
        .then(data => {
          if (data) {
            el('product-id').value = data.id;
            el('name').value = data.name;
            el('description').value = data.description;
            el('price').value = data.price;
            el('image_url').value = data.image_url || data.image || '';
            if (data.credentials && data.credentials.length > 0) {
              el('email1').value = data.credentials[0]?.email || '';
              el('password1').value = data.credentials[0]?.password || '';
              el('email2').value = data.credentials[1]?.email || '';
              el('password2').value = data.credentials[1]?.password || '';
            }
          }
        });
    }

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const emailPasswords = [];
      if (el('email1').value && el('password1').value) {
        emailPasswords.push({ email: el('email1').value, password: el('password1').value });
      }
      if (el('email2').value && el('password2').value) {
        emailPasswords.push({ email: el('email2').value, password: el('password2').value });
      }

		const payload = {
		  id: el('product-id').value || null,
		  name: el('name').value.trim(),
		  description: el('description').value.trim(),
		  price: parseFloat(el('price').value),        // FIX: Ensure price is a number
		  image_url: el('image_url').value.trim(),     // FIX: Ensure image_url is passed
		  emailPasswords
		};

		console.log('Sending product:', payload);

      try {
        const res = await fetch('/api/admin/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          alert('Product saved!');
          window.location.href = '/admin.html';
        } else {
          alert('Failed to save product');
        }
      } catch {
        alert('Network error');
      }
    });

    backBtn?.addEventListener('click', () => {
      window.location.href = '/admin.html';
    });
  }
});

