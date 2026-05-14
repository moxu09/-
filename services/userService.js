async function getUser(supabase, userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  if (!data) {
    const newUser = {
      user_id: userId,
      coins: 0,
      last_checkin: null
    };

    const { error: insertError } = await supabase
      .from('users')
      .insert([newUser]);

    if (insertError) {
      throw insertError;
    }

    return newUser;
  }

  return data;
}

async function updateCoins(supabase, userId, coins) {
  const { error } = await supabase
    .from('users')
    .update({ coins })
    .eq('user_id', userId);

  if (error) {
    throw error;
  }
}

async function updateCheckin(supabase, userId, date) {
  const { error } = await supabase
    .from('users')
    .update({ last_checkin: date })
    .eq('user_id', userId);

  if (error) {
    throw error;
  }
}

async function getUserRank(supabase, userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('coins', { ascending: false });

  if (error) {
    throw error;
  }

  const rank = data.findIndex((u) => u.user_id === userId);

  return rank === -1 ? null : rank + 1;
}

module.exports = {
  getUser,
  updateCoins,
  updateCheckin,
  getUserRank
};