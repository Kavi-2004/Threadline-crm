// 1. Staff එකතු කිරීම සඳහා (Frontend)
async function addStaff() {
  const input = document.getElementById('newStaffName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  // settings.staff_list යන්න ඔබේ Backend එකේ JSON.parse කර එන ලිස්ට් එකයි
  const staff = settings?.staff_list || [];
  if (staff.includes(name)) {
    input.value = '';
    return;
  }

  const newList = [...staff, name];
  
  // Backend එක බලාපොරොත්තු වන්නේ 'staffList' ය
  settings = await api('/api/me', {
    method: 'PATCH',
    body: { staffList: newList }
  });
  
  input.value = '';
  if (typeof renderStaffChips === 'function') renderStaffChips();
}

// 2. Staff කෙනෙකු ඉවත් කිරීම සඳහා (Frontend)
async function removeStaff(name) {
  const staff = settings?.staff_list || [];
  const newList = staff.filter(s => s !== name);

  settings = await api('/api/me', {
    method: 'PATCH',
    body: { staffList: newList }
  });

  if (typeof renderStaffChips === 'function') renderStaffChips();
}

// 3. Automatic Reply Template Save කිරීම සඳහා (Frontend)
async function saveTemplate() {
  const textarea = document.getElementById('replyTemplate');
  if (!textarea) return;
  const templateText = textarea.value;

  // Backend එක බලාපොරොත්තු වන්නේ 'replyTemplate' ය
  try {
    settings = await api('/api/me', {
      method: 'PATCH',
      body: { replyTemplate: templateText }
    });
    alert('Template saved successfully!');
  } catch (err) {
    console.error('Failed to save template:', err);
  }
}