const { normalizePhone, normalizeText } = require('./csv');

function phoneVariants(value = '') {
  const digits = normalizePhone(value);
  const variants = new Set();
  if (digits) variants.add(digits);
  if (digits.startsWith('810') && digits.length >= 12) variants.add(digits.slice(2));
  if (digits.startsWith('81') && !digits.startsWith('810') && digits.length >= 11) variants.add(`0${digits.slice(2)}`);
  if (digits.startsWith('0') && digits.length >= 10) variants.add(`81${digits.slice(1)}`);
  return Array.from(variants);
}

function scoreShipment(order, shipment) {
  let score = 0;
  const details = [];
  const orderPhone = normalizePhone(order.phone);
  const orderRecipient = normalizeText(order.recipient);

  if (shipment.pdfTypeLabel === 'ネコポス') {
    if (orderRecipient && shipment.normalizedBlockText.includes(orderRecipient)) {
      score += 90;
      details.push('氏名一致');
    }
    return { score, details };
  }

  if (orderPhone) {
    const orderPhoneVariants = phoneVariants(orderPhone);
    const phoneMatched = shipment.phoneCandidates.some(phone => {
      const candidateVariants = phoneVariants(phone);
      return orderPhoneVariants.some(orderValue => (
        candidateVariants.some(candidateValue => (
          candidateValue === orderValue ||
          (orderValue.length >= 7 && candidateValue.endsWith(orderValue)) ||
          (candidateValue.length >= 7 && orderValue.endsWith(candidateValue))
        ))
      ));
    });
    if (phoneMatched) {
      score += orderPhone.length >= 10 ? 90 : 75;
      details.push(orderPhone.length >= 10 ? '電話番号一致' : '電話番号末尾一致');
    }
  }

  return { score, details };
}

function customerMatchKey(order) {
  return `${normalizeText(order.recipient)}|${normalizePhone(order.phone)}`;
}

function matchOrdersToShipments(targetOrders, shipments) {
  const usedTrackingNumbers = new Set();
  const assignedByCustomer = new Map();

  return targetOrders.map(order => {
    const customerKey = customerMatchKey(order);
    const assigned = assignedByCustomer.get(customerKey);
    if (assigned) {
      return {
        ...order,
        trackingNumber: assigned.trackingNumber,
        status: 'matched',
        pdfPosition: assigned.pdfPosition,
        message: `同一氏名・電話番号のため同じ追跡番号を反映 / ${assigned.pdfPosition}`,
        score: assigned.score
      };
    }

    const scored = shipments
      .filter(shipment => !usedTrackingNumbers.has(shipment.trackingNumber))
      .map(shipment => ({ shipment, ...scoreShipment(order, shipment) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];

    if (!best || best.score < 70) {
      return {
        ...order,
        status: 'error',
        message: 'PDF内で一致する追跡番号が見つかりません',
        score: best?.score || 0
      };
    }

    if (second && best.score === second.score && best.score < 120) {
      return {
        ...order,
        status: 'error',
        message: '複数候補があり自動確定できません',
        score: best.score
      };
    }

    usedTrackingNumbers.add(best.shipment.trackingNumber);
    const matchedOrder = {
      ...order,
      trackingNumber: best.shipment.trackingNumber,
      status: 'matched',
      pdfPosition: best.shipment.pdfPosition,
      message: `${best.details.join('、')} / ${best.shipment.pdfPosition}`,
      score: best.score
    };
    assignedByCustomer.set(customerKey, matchedOrder);
    return matchedOrder;
  });
}

module.exports = {
  matchOrdersToShipments
};
