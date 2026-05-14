async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  if (customId === 'test_button') {
    return interaction.reply({
      content: '按鈕成功',
      flags: 64
    });
  }
}

module.exports = {
  handleButtonInteraction
};