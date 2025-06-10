// Elements
const productsContainer = document.getElementById('products-container');
const searchInput = document.getElementById('search');
const buyPopup = document.getElementById('buy-popup');
const popupProductName = document.getElementById('popup-product-name');
const buyerEmailInput = document.getElementById('buyer-email');
const confirmBuyBtn = document.getElementById('confirm-buy');
const cancelBuyBtn = document.getElementById('cancel-buy');
const notification = document.getElementById('notification');
const logo = document.getElementById('logo');

let products = [];
let selectedProduct = null;
let logoClickCount = 0;
let logoClickTimeout = null;

// Fetch products from server
async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error('Server error while fetching products');
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error('Invalid products data');

    products = data;
    displayProducts(products);
  } catch (err) {
    showNotification('Failed to load products');
    console.error('Fetch error:', err);
  }
}

// Display products in the container
function displayProducts(productsToShow) {
  productsContainer.innerHTML = '';
  if (!Array.isArray(productsToShow) || productsToShow.length === 0) {
    productsContainer.innerHTML = '<p>No products found.</p>';
    return;
  }

  productsToShow.forEach(product => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <img src="${product.image_url}" alt="${product.name}">
      <h3>${product.name}</h3>
      <p class="description">${product.description}</p>
      <p class="price">$${parseFloat(product.price).toFixed(2)}</p>
      <button class="buy-btn" data-id="${product.id}">Buy</button>
    `;
    productsContainer.appendChild(card);
  });
}

// Filter products on search
searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase().trim();
  if (!Array.isArray(products)) return;
  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(query) ||
    p.description.toLowerCase().includes(query)
  );
  displayProducts(filtered);
});

// Handle Buy button click (event delegation)
productsContainer.addEventListener('click', e => {
  if (e.target.classList.contains('buy-btn')) {
    const id = e.target.getAttribute('data-id');
    selectedProduct = products.find(p => p.id == id);
    if (!selectedProduct) return;
    buyerEmailInput.value = '';
    popupProductName.textContent = selectedProduct.name;
    buyPopup.classList.remove('hidden');
    buyerEmailInput.focus();
  }
});

// Cancel buy popup
cancelBuyBtn.addEventListener('click', () => {
  buyPopup.classList.add('hidden');
  selectedProduct = null;
});

// Confirm buy popup - submit order
confirmBuyBtn.addEventListener('click', async () => {
  const email = buyerEmailInput.value.trim();
  if (!email || !validateEmail(email)) {
    alert('Please enter a valid email.');
    return;
  }
  if (!selectedProduct) return;

  confirmBuyBtn.disabled = true;
  confirmBuyBtn.textContent = 'Processing...';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: selectedProduct.id,
        buyerEmail: email
      })
    });
    if (res.ok) {
      showNotification('Order placed! Check your email for next steps.');
      buyPopup.classList.add('hidden');
      selectedProduct = null;
    } else {
      const data = await res.json();
      alert('Error: ' + (data.message || 'Failed to place order'));
    }
  } catch (err) {
    alert('Network error. Try again later.');
    console.error(err);
  } finally {
    confirmBuyBtn.disabled = false;
    confirmBuyBtn.textContent = 'Buy';
  }
});

// Simple email validation
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Show temporary notification
function showNotification(message) {
  notification.textContent = message;
  notification.classList.remove('hidden');
  setTimeout(() => {
    notification.classList.add('hidden');
  }, 4000);
}

// Admin unlock: triple-click logo triggers prompt for password
logo.addEventListener('click', () => {
  logoClickCount++;
  if (logoClickTimeout) clearTimeout(logoClickTimeout);
  logoClickTimeout = setTimeout(() => {
    logoClickCount = 0;
  }, 800);

  if (logoClickCount === 3) {
    logoClickCount = 0;
    const password = prompt('Enter admin password:');
    if (!password) return;

    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }).then(res => {
      if (res.ok) {
        window.location.href = '/admin.html';
      } else {
        alert('Wrong password');
      }
    }).catch(() => alert('Network error'));
  }
});

// Initial load
fetchProducts();
